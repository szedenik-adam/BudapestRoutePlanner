#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s {install|remove|start|stop|enable|disable}\n' "$0" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

mode=$1

if [[ -z "${HOME:-}" ]]; then
  printf 'HOME must be set to install the user service.\n' >&2
  exit 1
fi

library_dir="$HOME/.local/lib/budapest-route-planner"
config_dir="$HOME/.config/budapest-route-planner"
unit_dir="$HOME/.config/systemd/user"
data_dir="$HOME/.local/share/budapest-route-planner/realtime"
unit_file="$unit_dir/realtime-poller.service"
env_file="$config_dir/realtime-poller.env"

case "$mode" in
  install)
    if [[ -z "${REALTIME_API_KEY:-}" ]]; then
      if [[ ! -r /dev/tty ]]; then
        printf 'REALTIME_API_KEY is unset and no interactive terminal is available.\n' >&2
        exit 1
      fi

      printf 'BKK realtime API key: ' > /dev/tty
      if ! IFS= read -r -s REALTIME_API_KEY < /dev/tty; then
        printf '\nFailed to read the API key.\n' > /dev/tty
        exit 1
      fi
      printf '\n' > /dev/tty
    fi

    if [[ -z "$REALTIME_API_KEY" ]]; then
      printf 'REALTIME_API_KEY must not be empty.\n' >&2
      exit 1
    fi

    if [[ "$REALTIME_API_KEY" == *$'\n'* || "$REALTIME_API_KEY" == *$'\r'* ]]; then
      printf 'REALTIME_API_KEY must not contain newline characters.\n' >&2
      exit 1
    fi

    if [[ ! -x /usr/bin/node ]]; then
      printf 'Node.js 22 or newer must be installed at /usr/bin/node.\n' >&2
      exit 1
    fi

    node_major=$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')
    if (( node_major < 22 )); then
      printf 'Node.js 22 or newer is required; found version %s.\n' "$(/usr/bin/node --version)" >&2
      exit 1
    fi

    script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
    install -d -m 0755 "$library_dir" "$unit_dir" "$data_dir"
    install -d -m 0700 "$config_dir"
    install -m 0644 "$script_dir/realtime-poller.mjs" "$library_dir/realtime-poller.mjs"
    install -m 0644 "$script_dir/timetable-sync-worker.mjs" "$library_dir/timetable-sync-worker.mjs"
    install -m 0644 "$script_dir/realtime-poller.service" "$unit_file"

    escaped_key=${REALTIME_API_KEY//\\/\\\\}
    escaped_key=${escaped_key//\"/\\\"}
    umask 077
    temporary_env_file="$env_file.$$.tmp"
    : > "$temporary_env_file"
    if [[ -f "$env_file" ]]; then
      while IFS= read -r line; do
        case "$line" in
          REALTIME_API_KEY=*) ;;
          *) printf '%s\n' "$line" >> "$temporary_env_file" ;;
        esac
      done < "$env_file"
    fi
    printf 'REALTIME_API_KEY="%s"\n' "$escaped_key" >> "$temporary_env_file"
    chmod 0600 "$temporary_env_file"
    mv -f "$temporary_env_file" "$env_file"

    systemctl --user daemon-reload
    systemctl --user enable --now realtime-poller.service
    printf 'Installed and started the realtime recorder user service.\n'
    ;;
  remove)
    if [[ -f "$unit_file" ]]; then
      systemctl --user disable --now realtime-poller.service
    fi
    rm -f "$unit_file" "$library_dir/realtime-poller.mjs" \
      "$library_dir/timetable-sync-worker.mjs" "$env_file"
    systemctl --user daemon-reload
    printf 'Removed the realtime recorder service and its API key. Recorded data was preserved.\n'
    ;;
  start)
    systemctl --user start realtime-poller.service
    ;;
  stop)
    systemctl --user stop realtime-poller.service
    ;;
  enable)
    systemctl --user enable realtime-poller.service
    ;;
  disable)
    systemctl --user disable realtime-poller.service
    ;;
  *)
    usage
    exit 2
    ;;
esac
