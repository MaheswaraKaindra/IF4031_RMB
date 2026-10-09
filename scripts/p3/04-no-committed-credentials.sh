#!/usr/bin/env bash
# P3 criterion 4: no credential is hardcoded or committed, and .env.example is provided.
# Expect: .env is ignored by git, .env.example exists with placeholders only,
# and no real credential pattern appears in tracked or untracked (non-ignored) files.
. "$(dirname "$0")/../lib.sh"

step ".env is ignored by git"
git check-ignore -v .env

step ".env.example is present and holds placeholders only"
ls -l .env.example
grep -E '^(X_BMKG_KEY|PVMBG_TOKEN|JWT_PRIVATE_KEY_B64|AUTH_CLIENT_BNPB_OPS_SECRET)=' .env.example

step "Searching the repository for real credentials (expect no output)"
# [T] keeps the pattern from matching this line itself
git grep --untracked -n -E 'bmkg_[0-9a-f]{64}|pvmbg\.v1\.[A-Za-z0-9_-]{43}|BEGIN [A-Z ]*PRIVATE KEY|LS0tLS1CRUdJ[T]' \
    | grep -v -E 'bmkg_0{64}|pvmbg\.v1\.A{43}' \
    || echo "no credentials found"
