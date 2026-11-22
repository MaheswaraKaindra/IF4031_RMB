import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type ClientClass = 'field_team' | 'ops' | 'media';

export interface AdmissionLimits {
    total: number; // all classes together
    reservedFieldTeam: number; // slots only Tim Lapangan may use
    mediaMax: number; // ceiling for Media alone
}

export function classify(clientId: string | undefined): ClientClass {
    if (clientId === 'field-team') return 'field_team';
    if (clientId === 'bnpb-ops') return 'ops';
    return 'media';
}

// Capacity partition, not a queue: a request is admitted or rejected immediately, so memory and latency stay bounded.
// Tim Lapangan may use every slot. Everyone else together stops at total - reservedFieldTeam, and Media stops at mediaMax,
// so a Media flood can never take the slots reserved for Tim Lapangan.
export class PriorityAdmission {
    private readonly active: Record<ClientClass, number> = { field_team: 0, ops: 0, media: 0 };
    readonly rejected: Record<ClientClass, number> = { field_team: 0, ops: 0, media: 0 };

    readonly limits: AdmissionLimits;

    constructor(limits: AdmissionLimits) {
        // A small total (for example the M1 overload test with MAX_IN_FLIGHT=5) must still leave room for the other classes.
        this.limits = { ...limits, reservedFieldTeam: Math.max(0, Math.min(limits.reservedFieldTeam, limits.total - 1)) };
    }

    get inFlight(): Readonly<Record<ClientClass, number>> {
        return this.active;
    }

    tryAdmit(cls: ClientClass): (() => void) | null {
        const sum = this.active.field_team + this.active.ops + this.active.media;
        const others = this.active.ops + this.active.media;
        let ok: boolean;
        if (cls === 'field_team') ok = sum < this.limits.total;
        else if (cls === 'ops') ok = sum < this.limits.total && others < this.limits.total - this.limits.reservedFieldTeam;
        else ok = sum < this.limits.total && others < this.limits.total - this.limits.reservedFieldTeam && this.active.media < this.limits.mediaMax;
        if (!ok) {
            this.rejected[cls]++;
            return null;
        }
        this.active[cls]++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active[cls]--;
        };
    }
}

export interface AdmissionHooks {
    onAdmit?: (cls: ClientClass) => void;
    onReject?: (cls: ClientClass) => void;
}

// Place after authentication: the class comes from the verified token subject.
export function priorityAdmission(admission: PriorityAdmission, hooks: AdmissionHooks = {}): RequestHandler {
    return (_req: Request, res: Response, next: NextFunction): void => {
        const cls = classify(res.locals.clientId as string | undefined);
        const release = admission.tryAdmit(cls);
        if (!release) {
            hooks.onReject?.(cls);
            res.setHeader('Retry-After', '1');
            res.status(429).json({ error: 'overloaded', error_description: 'Capacity for this client class is exhausted, retry shortly', client_class: cls });
            return;
        }
        hooks.onAdmit?.(cls);
        res.on('finish', release);
        res.on('close', release);
        next();
    };
}
