/**
 * A recording is deleted only after it is safe elsewhere. These cases used to
 * pass silently: a failed Nextcloud upload or a failed repeat copy was logged
 * and the source file was unlinked anyway.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ApiConnectorNextcloud from '../src/classes/api-connector-nextcloud';
import BroadcastSchema from '../src/classes/broadcast-schema';
import { createFinishedHandler } from '../src/autopilot';
import { copyFile } from '../src/helper/files';
import { TimeSlot } from '../src/types/types';

const nextcloud = () =>
  new ApiConnectorNextcloud({
    baseUrl: 'https://cloud.invalid',
    targetDirectory: 'Sendungen',
    username: 'u',
    password: 'p',
  });

describe('upload safety', () => {
  test('a failed Nextcloud upload rejects', async () => {
    const uploader = nextcloud();
    jest.spyOn(uploader, 'uploadToNextcloud').mockRejectedValue(new Error('503'));
    await expect(uploader.upload({ sourceFile: '/tmp/x.mp3' } as any)).rejects.toThrow('503');
  });

  test('a failed Nextcloud upload keeps the source file', async () => {
    const uploader = nextcloud();
    jest.spyOn(uploader, 'uploadToNextcloud').mockRejectedValue(new Error('503'));
    const unlinkFile = jest.fn();
    const copyRepeat = jest.fn();

    const { handler, waitForPending } = createFinishedHandler({
      uploaderWelocal: null,
      uploaderNextcloud: uploader,
      doCopyRepeat: true,
      filenameSuffix: '.mp3',
      copyRepeat,
      unlinkFile,
      log: () => {},
      logError: () => {},
    });

    handler('/tmp/x.mp3', {} as TimeSlot);
    await waitForPending();

    expect(copyRepeat).not.toHaveBeenCalled();
    expect(unlinkFile).not.toHaveBeenCalled();
  });

  test('a failed repeat copy keeps the source file', async () => {
    const unlinkFile = jest.fn();
    const { handler, waitForPending } = createFinishedHandler({
      uploaderWelocal: null,
      uploaderNextcloud: null,
      doCopyRepeat: true,
      filenameSuffix: '.mp3',
      copyRepeat: () => {
        throw new Error('ENOSPC');
      },
      unlinkFile,
      log: () => {},
      logError: () => {},
    });

    handler('/tmp/x.mp3', {} as TimeSlot);
    await waitForPending();

    expect(unlinkFile).not.toHaveBeenCalled();
  });

  test('copyFile throws when the copy fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radiobox-copy-'));
    try {
      expect(() => copyFile(path.join(dir, 'missing.mp3'), dir, 'repeat.mp3')).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema header', () => {
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  test('finds the weekday columns', () => {
    const s = Object.create(BroadcastSchema.prototype) as BroadcastSchema;
    s.weekdayColNames = weekdays;
    s.setWeekdayColIds(['Name', ...weekdays]);
    expect(s.weekdayColIds).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('refuses a sheet with a weekday column missing', () => {
    const s = Object.create(BroadcastSchema.prototype) as BroadcastSchema;
    s.weekdayColNames = weekdays;
    expect(() => s.setWeekdayColIds(['Name', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])).toThrow(
      /Sun/
    );
  });

  test('refuses a weekday in the name column', () => {
    const s = Object.create(BroadcastSchema.prototype) as BroadcastSchema;
    s.weekdayColNames = weekdays;
    expect(() => s.setWeekdayColIds(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).toThrow(
      /Mon/
    );
  });
});
