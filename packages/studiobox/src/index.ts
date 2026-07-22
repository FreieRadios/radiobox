import { loadConfig } from './config/load';
import { Pipeline } from './pipeline';
import { PlayoutPipeline } from './playout';
import { makeLog } from './util/log';

const log = makeLog('studiobox');

function main(): void {
  // Allow `--config path` / `--profiles path` overrides.
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const cfg = loadConfig({ configPath: getArg('--config'), profilesPath: getArg('--profiles') });

  // `playout` skips capture/DSP entirely — file player -> local hardware only.
  const pipeline =
    cfg.mode === 'playout'
      ? (log.info('mode: playout (no capture/DSP)'), new PlayoutPipeline(cfg))
      : (log.info(`loaded config: ${cfg.channels.map((c) => `${c.label}(${c.role})`).join(', ')}`),
        new Pipeline(cfg));
  pipeline.start();

  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    pipeline.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  log.error((err as Error).message);
  process.exit(1);
}
