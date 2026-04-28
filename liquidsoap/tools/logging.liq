# Common logging configuration to stdout and a per-script file.
# Requires: home_path (from var.liq)
settings.log.file.path.set("#{home_path}/logs/<script>.log")
settings.log.stdout.set(true)
log.level.set(3)
