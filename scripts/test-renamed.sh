#!/usr/bin/env bash
# Runs Bops' own tests against Oshy Ops with the names swapped back, so the rename can't hide a change in
# behaviour. Oshy Ops renames what people see (Bops -> Oshy Ops, Boppy -> Oshy, docs/WINDOWS.md); Bops' tests
# check that wording exactly. So this copies the app to a temporary folder, swaps the names back there only,
# and runs the tests from scripts/ (or the ones named) against it. A test that fails here and passes on
# upstream (git worktree of origin/main) is a real change, not wording.
#
#   scripts/test-renamed.sh                   every scripts/test-*.mjs
#   scripts/test-renamed.sh test-keys test-web
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$root"
git ls-files -z | tar --null -cf - -T - | tar -xf - -C "$work"
ln -s "$root/node_modules" "$work/node_modules"
cd "$work"
grep -rlE "Oshy" lib components app desktop | xargs sed -i -E 's/\b([Aa])n Oshy Ops/\1 Bops/g; s/Oshy Ops/Bops/g; s/\bOshy\b/Boppy/g'
npx next typegen > /dev/null 2>&1 || true
tests=("$@")
[ ${#tests[@]} -gt 0 ] || mapfile -t tests < <(ls scripts/test-*.mjs | xargs -n1 basename | sed 's/\.mjs$//')
failed=()
for t in "${tests[@]}"; do
  if timeout 300 node --conditions=react-server "scripts/$t.mjs" > "$work/$t.log" 2>&1; then echo "ok   $t"; else echo "FAIL $t"; failed+=("$t"); sed -n 1,15p "$work/$t.log" | grep -v '^\s*at ' | sed 's/^/     /'; fi
done
echo "${#tests[@]} run, ${#failed[@]} failed${failed:+: ${failed[*]}}"
