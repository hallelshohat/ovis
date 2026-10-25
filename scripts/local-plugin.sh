#!/bin/sh
# Run Ovis in herdr from a local checkout (a fork or branch), or put the GitHub install back.
#   sh scripts/local-plugin.sh link [DIR]     build DIR (default: this checkout), link it, restart Ovis
#   sh scripts/local-plugin.sh unlink [REF]   reinstall devswha/ovis at REF (default: latest release), restart Ovis
# herdr keys the plugin's config and state by its id, and the app keeps its own in ~/.config/ovis,
# so neither way sets anything up again. `herdr plugin link` only records the path: the build and
# the restart are this script's.
set -eu
ID=devswha.ovis
REPO=devswha/ovis
HERE=$(cd "$(dirname "$0")/.." && pwd)

bun_in() { (cd "$1" && shift && sh scripts/with-bun.sh "$@"); }
plugin_root() {
  herdr plugin list --json | bun_in "$HERE" -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "'"$ID"'")?.plugin_root ?? "")'
}

case "${1:-}" in
  link)
    root=$(cd "${2:-$HERE}" && pwd)
    # the same steps as [[build]] in herdr-plugin.toml
    sh "$root/scripts/preflight.sh"
    bun_in "$root" install
    bun_in "$root" run build
    bun_in "$root" scripts/pty-sidecar.ts install
    bun_in "$root" scripts/plugin.ts stop
    herdr plugin link "$root" >/dev/null
    ;;
  unlink)
    # the latest release: the highest plain vX.Y.Z tag, as the in-app updater picks it
    ref=${2:-$(git ls-remote --tags --refs --sort=-v:refname "https://github.com/$REPO" | sed -n 's|.*refs/tags/\(v[0-9]*\.[0-9]*\.[0-9]*\)$|\1|p' | head -n 1)}
    bun_in "$(plugin_root)" scripts/plugin.ts stop
    herdr plugin unlink "$ID" >/dev/null
    herdr plugin install "$REPO" --ref "$ref" --yes >/dev/null
    root=$(plugin_root)
    ;;
  *)
    sed -n '2,3s/^# //p' "$0" >&2
    exit 2
    ;;
esac
bun_in "$root" scripts/plugin.ts start
herdr plugin list | grep "$ID"
