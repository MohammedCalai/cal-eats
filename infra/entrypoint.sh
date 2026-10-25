#!/bin/sh
set -eu
# Mounted storage replaces the image directory. Initialise only its ownership,
# then run the application without root privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  exec gosu node "$@"
fi
exec "$@"
