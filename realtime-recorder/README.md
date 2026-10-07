# GTFS realtime recorder

`realtime-poller.mjs` is a standalone Node.js 22 service that polls BKK vehicle positions every five seconds. It records only changed protobuf responses, without modifying the browser poller or adding npm dependencies.

Changed protobuf responses are written as raw, timestamp-named entries in hourly tar archives under `~/.local/share/budapest-route-planner/realtime` by default (override with `REALTIME_DATA_DIR`). Completed hours are gzip-compressed as `YYYY-MM-DDTHH.tar.gz`; the active hour is an uncompressed `.tar` while the recorder is running. On restart, the recorder resumes the current hour by reopening its archive and discarding any incomplete trailing entry. Tar archives older than 30 days are removed; timetable snapshots remain alongside them.

The corresponding day timetable (`YYYY-MM-DD-<day_number>.json[.zip]`) and versioned common timetables (`YYYY-MM-DD-common[-<version>].json[.zip]`) are stored alongside the archives. When a day timetable is not already stored, a background worker checks local generated files in `timetable-generator/budapest` first, then fetches missing day data from `https://bprp.pages.dev/timetable/`. When it acquires a day timetable, it also checks the local and remote `common.json.zip`; identical ZIP contents are not duplicated, while a changed version is saved with that date. Older timetable filenames are migrated to the date-prefixed format when encountered. This retrieval runs separately from the five-second polling loop. Set `GTFS_TIMETABLE_SOURCE_DIR` to use a different local generated-files directory, for example by adding `GTFS_TIMETABLE_SOURCE_DIR=/path/to/timetable-generator/budapest` to `~/.config/budapest-route-planner/realtime-poller.env`.

List or extract entries with standard tar tools:

```sh
tar -tzf 2026-10-06T10.tar.gz
tar -xOf 2026-10-06T10.tar.gz 2026-10-06T10-00-00.000Z.pb
```

## Run manually

Set `REALTIME_API_KEY` in the environment and run:

```sh
node realtime-poller.mjs
```

## Install as a user service

The recorder uses only Node.js built-ins; the rest of the repository is not required on the server. The installer copies both runtime scripts. Install Node.js 22 or newer at `/usr/bin/node` (or update that path in the unit). Run the service script from this directory:

```sh
./service.sh install
```

If `REALTIME_API_KEY` is set in the environment, `service.sh` uses it; otherwise, it securely prompts for the key without echoing it. The script saves the key in a protected user configuration file, installs the poller and systemd unit, then enables and starts the service.

The other modes control or remove the installed service:

```sh
./service.sh start
./service.sh stop
./service.sh enable
./service.sh disable
./service.sh remove
```

`remove` stops and disables the service, removes the installed script, unit, and saved API key, but preserves recorded data. Check the service with `systemctl --user status realtime-poller.service`.

The unit stores hourly archives under `~/.local/share/budapest-route-planner/realtime`. To keep it running after logout and start it at boot, enable lingering for your account:

```sh
sudo loginctl enable-linger "$USER"
```
