#!/usr/bin/env python3
"""Compiler PDF untuk laporan Milestone 2 (LaTeX -> PDF).

Penggunaan:
    python compile.py
    python compile.py --engine pdflatex
    python compile.py --check
    python compile.py --clean
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
MAIN_TEX = "main.tex"
DEFAULT_OUTPUT = "IF4031_M2_RMB.pdf"
BUILD_DIR = ROOT_DIR / "build"

INPUT_RE = re.compile(r"\\input\{([^}]+)\}")


def resolve_engine(preferred: str) -> tuple[str, str, bool]:
    """Temukan binary compiler LaTeX di Windows PATH, folder standar, atau WSL.

    Mengembalikan tuple (kind, executable_path, via_wsl).
    """
    candidates = (
        ["pdflatex", "xelatex", "lualatex", "tectonic", "latexmk"]
        if preferred == "auto"
        else [preferred]
    )

    extra_dirs: list[Path] = []
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA", "")
        program_files = os.environ.get("ProgramFiles", r"C:\Program Files")
        extra_dirs.extend([
            Path(local_app) / "Programs" / "MiKTeX" / "miktex" / "bin" / "x64",
            Path(program_files) / "MiKTeX" / "miktex" / "bin" / "x64",
            Path(r"C:\texlive\2026\bin\windows"),
            Path(r"C:\texlive\2025\bin\windows"),
            Path(r"C:\texlive\2024\bin\windows"),
        ])

    for name in candidates:
        found = shutil.which(name)
        if found:
            return name, found, False
        for d in extra_dirs:
            exe = d / (f"{name}.exe" if os.name == "nt" else name)
            if exe.is_file():
                return name, str(exe), False

    if os.name == "nt" and shutil.which("wsl"):
        for name in candidates:
            probe = subprocess.run(
                ["wsl", "which", name],
                capture_output=True,
                text=True,
            )
            if probe.returncode == 0 and probe.stdout.strip():
                return name, probe.stdout.strip(), True

    return "", "", False


def check_structure() -> list[str]:
    """Periksa keterhubungan seluruh file .tex yang di-\\input dari main.tex."""
    errors: list[str] = []
    main_path = ROOT_DIR / MAIN_TEX
    if not main_path.is_file():
        return [f"File utama tidak ditemukan: {main_path}"]

    visited: set[Path] = set()
    queue: list[Path] = [main_path]

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)

        text = current.read_text(encoding="utf-8")
        for match in INPUT_RE.finditer(text):
            rel = match.group(1).strip()
            target = ROOT_DIR / (rel if rel.endswith(".tex") else f"{rel}.tex")
            if not target.is_file():
                errors.append(f"Referensi \\input tidak ditemukan di {current.name}: {target}")
            else:
                queue.append(target)

    print(f"[CHECK] Terverifikasi {len(visited)} file .tex saling terhubung tanpa referensi putus.")
    return errors


def to_wsl_path(win_path: Path) -> str:
    res = subprocess.run(["wsl", "wslpath", "-u", str(win_path)], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Gagal konversi path WSL untuk {win_path}: {res.stderr.strip()}")
    return res.stdout.strip()


def run_step(cmd: list[str], cwd: Path, via_wsl: bool) -> int:
    if via_wsl:
        wsl_cwd = to_wsl_path(cwd)
        joined = " ".join(f'"{c}"' if " " in c else c for c in cmd)
        full_cmd = ["wsl", "bash", "-lc", f'cd "{wsl_cwd}" && {joined}']
        proc = subprocess.run(full_cmd)
        return proc.returncode
    proc = subprocess.run(cmd, cwd=str(cwd))
    return proc.returncode


def build_pdf(engine: str, output_name: str, passes: int) -> int:
    errors = check_structure()
    if errors:
        for err in errors:
            print(f"[ERROR] {err}", file=sys.stderr)
        return 1

    kind, exe, via_wsl = resolve_engine(engine)
    if not kind:
        print(
            "[ERROR] Tidak ada compiler LaTeX yang ditemukan di Windows maupun WSL.\n"
            "Silakan pasang salah satu compiler berikut terlebih dahulu:\n"
            "  - Windows (MiKTeX)      : winget install MiKTeX.MiKTeX\n"
            "  - WSL Ubuntu (TeX Live) : sudo apt update && sudo apt install -y texlive-latex-extra texlive-lang-other texlive-fonts-recommended latexmk\n"
            "Atau unggah isi folder docs/milestone-2/ langsung ke Overleaf.",
            file=sys.stderr,
        )
        return 2

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[BUILD] Memakai engine: {kind} ({'WSL: ' + exe if via_wsl else exe})")

    if kind == "tectonic":
        cmd = [exe if not via_wsl else kind, "-X", "compile", MAIN_TEX, "--outdir", "build"]
        rc = run_step(cmd, ROOT_DIR, via_wsl)
        if rc != 0:
            return rc
    elif kind == "latexmk":
        cmd = [
            exe if not via_wsl else kind,
            "-pdf",
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-output-directory=build",
            MAIN_TEX,
        ]
        rc = run_step(cmd, ROOT_DIR, via_wsl)
        if rc != 0:
            return rc
    else:
        cmd = [
            exe if not via_wsl else kind,
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-output-directory=build",
            MAIN_TEX,
        ]
        for i in range(1, passes + 1):
            print(f"[BUILD] Pass {i}/{passes}...")
            rc = run_step(cmd, ROOT_DIR, via_wsl)
            if rc != 0:
                return rc

    built_pdf = BUILD_DIR / "main.pdf"
    if not built_pdf.is_file():
        print(f"[ERROR] Kompilasi selesai tetapi {built_pdf} tidak ditemukan.", file=sys.stderr)
        return 1

    dest_pdf = ROOT_DIR / output_name
    shutil.copy2(built_pdf, dest_pdf)
    print(f"[OK] PDF berhasil dibuat: {dest_pdf}")
    return 0


def clean_build() -> None:
    if BUILD_DIR.exists():
        shutil.rmtree(BUILD_DIR)
        print(f"[CLEAN] Menghapus direktori bantu: {BUILD_DIR}")
    else:
        print("[CLEAN] Tidak ada direktori build yang perlu dihapus.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Compile template LaTeX Laporan Milestone 2 menjadi PDF.")
    parser.add_argument(
        "--engine",
        default="auto",
        choices=["auto", "latexmk", "pdflatex", "xelatex", "lualatex", "tectonic"],
        help="Pilih engine LaTeX (bawaan: auto)",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help=f"Nama file PDF keluaran di dalam docs/milestone-2/ (bawaan: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--passes",
        type=int,
        default=2,
        help="Jumlah pass untuk pdflatex/xelatex/lualatex agar Daftar Isi & referensi silang akurat (bawaan: 2)",
    )
    parser.add_argument("--check", action="store_true", help="Periksa struktur \\input dan ketersediaan compiler tanpa build")
    parser.add_argument("--clean", action="store_true", help="Hapus folder build/ sementara")
    args = parser.parse_args()

    if args.clean:
        clean_build()
        return 0

    if args.check:
        errors = check_structure()
        kind, exe, via_wsl = resolve_engine(args.engine)
        if kind:
            print(f"[CHECK] Compiler terdeteksi: {kind} ({'WSL: ' + exe if via_wsl else exe})")
        else:
            print("[CHECK] Compiler LaTeX belum terpasang (jalankan --engine ... setelah memasang TeX/Tectonic).")
        if errors:
            for err in errors:
                print(f"[ERROR] {err}", file=sys.stderr)
            return 1
        return 0

    return build_pdf(args.engine, args.output, max(1, args.passes))


if __name__ == "__main__":
    raise SystemExit(main())
