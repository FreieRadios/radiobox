/**
 * Autopilot tests.
 *
 * These tests intentionally do NOT rely on .env values or on the
 * project's xlsx schema file (e.g. /app/schema/radio-z.xlsx). Instead,
 * we mock `dataFromXlsx` so `BroadcastSchema` is fed an in-memory
 * worksheet, which keeps the tests hermetic and fast.
 */

// Mock the file-helpers module so BroadcastSchema does not touch the
// real filesystem when looking up the xlsx schema. We keep all other
// helpers (copyRepeat, unlinkFile, ...) as no-op stubs.
jest.mock("../src/helper/files", () => {
  const actual = jest.requireActual("../src/helper/files");
  return {
    ...actual,
    // In-memory worksheet: header row (with weekday names) + one broadcast row.
    // The "Mon" cell defines a schedule for Monday at 14:00.
    dataFromXlsx: jest.fn(() => [
      ["Name", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Genre"],
      [
        "TestShow",
        'M:[1-12],D:[1-5],H:[14]',
        "",
        "",
        "",
        "",
        "",
        "",
        "Talk",
      ],
    ]),
    // Stubs for fs side-effects so the test never writes to disk.
    copyRepeat: jest.fn(),
    unlinkFile: jest.fn(),
    unlinkFilesByType: jest.fn(),
    getPath: (p: string) => p,
  };
});

import { DateTime } from "luxon";
import BroadcastSchema from "../src/classes/broadcast-schema";
import BroadcastSchedule from "../src/classes/broadcast-schedule";
import BroadcastRecorder from "../src/classes/broadcast-recorder";
import { createFinishedHandler } from "../src/autopilot";
import { TimeSlot } from "../src/types/types";

describe("autopilot", () => {
  const buildSchedule = () => {
    const schema = new BroadcastSchema({
      schemaFile: "in-memory.xlsx",
      stationName: "TestStation",
    });
    // A Monday at 14:00 - matches the H:[14] schedule defined above.
    const dateStart = DateTime.fromISO("2024-08-26T14:00:00");
    const dateEnd = dateStart.plus({ hours: 1 });
    return new BroadcastSchedule({
      schema,
      dateStart,
      dateEnd,
      locale: "de",
      repeatShort: " (rep.)",
    });
  };

  test("createFinishedHandler runs welocal -> nextcloud -> copyRepeat -> unlinkFile in order", async () => {
    const calls: string[] = [];

    const uploaderWelocal = {
      getUploadFileInfo: jest.fn((sourceFile: string, _slot: TimeSlot) => ({
        sourceFile,
        targetName: "target.mp3",
      })),
      upload: jest.fn(async () => {
        calls.push("welocal.upload");
      }),
    };
    const uploaderNextcloud = {
      getUploadFileInfo: jest.fn((sourceFile: string) => ({ sourceFile })),
      upload: jest.fn(async () => {
        calls.push("nextcloud.upload");
      }),
    };
    const copyRepeatStub = jest.fn(() => {
      calls.push("copyRepeat");
    });
    const unlinkFileStub = jest.fn(() => {
      calls.push("unlinkFile");
    });

    const { handler, pendingJobs, waitForPending } = createFinishedHandler({
      uploaderWelocal,
      uploaderNextcloud,
      doCopyRepeat: true,
      filenameSuffix: ".mp3",
      copyRepeat: copyRepeatStub,
      unlinkFile: unlinkFileStub,
      log: () => {},
      logError: () => {},
    });

    const fakeSlot = { start: DateTime.now(), end: DateTime.now() } as unknown as TimeSlot;
    handler("/tmp/test.mp3", fakeSlot);

    expect(pendingJobs.length).toBe(1);
    await waitForPending();
    expect(pendingJobs.length).toBe(0);

    expect(uploaderWelocal.upload).toHaveBeenCalledTimes(1);
    expect(uploaderNextcloud.upload).toHaveBeenCalledTimes(1);
    expect(copyRepeatStub).toHaveBeenCalledWith("/tmp/test.mp3", fakeSlot, ".mp3");
    expect(unlinkFileStub).toHaveBeenCalledWith("/tmp/test.mp3");
    expect(calls).toEqual([
      "welocal.upload",
      "nextcloud.upload",
      "copyRepeat",
      "unlinkFile",
    ]);
  });

  test("createFinishedHandler skips uploaders when null and still cleans up", async () => {
    const copyRepeatStub = jest.fn();
    const unlinkFileStub = jest.fn();

    const { handler, waitForPending } = createFinishedHandler({
      uploaderWelocal: null,
      uploaderNextcloud: null,
      doCopyRepeat: false,
      filenameSuffix: ".mp3",
      copyRepeat: copyRepeatStub,
      unlinkFile: unlinkFileStub,
      log: () => {},
      logError: () => {},
    });

    handler("/tmp/test.mp3", {} as TimeSlot);
    await waitForPending();

    expect(copyRepeatStub).not.toHaveBeenCalled();
    expect(unlinkFileStub).toHaveBeenCalledWith("/tmp/test.mp3");
  });

  test("createFinishedHandler swallows uploader errors and still removes job from pending", async () => {
    const uploaderWelocal = {
      getUploadFileInfo: jest.fn(() => ({ sourceFile: "x" })),
      upload: jest.fn(async () => {
        throw new Error("boom");
      }),
    };

    const { handler, pendingJobs, waitForPending } = createFinishedHandler({
      uploaderWelocal,
      uploaderNextcloud: null,
      doCopyRepeat: false,
      filenameSuffix: ".mp3",
      copyRepeat: jest.fn(),
      unlinkFile: jest.fn(),
      log: () => {},
      logError: () => {},
    });

    handler("/tmp/x.mp3", {} as TimeSlot);
    expect(pendingJobs.length).toBe(1);
    await waitForPending();
    expect(pendingJobs.length).toBe(0);
    expect(uploaderWelocal.upload).toHaveBeenCalled();
  });

  test("BroadcastRecorder fires 'finished' which drives the autopilot handler (uses in-memory schema)", async () => {
    const schedule = buildSchedule();

    // Sanity: our in-memory schema produced a real grid.
    const grid = schedule.getGrid();
    expect(grid.length).toBeGreaterThan(0);
    expect(grid[0].broadcast?.name).toBe("TestShow");

    const recorder = new BroadcastRecorder({
      schedule,
      streamUrl: "http://example.invalid/stream",
      filenamePrefix: "test",
      filenameSuffix: ".mp3" as any,
    });

    const uploadCalls: string[] = [];
    const { handler, waitForPending } = createFinishedHandler({
      uploaderWelocal: {
        getUploadFileInfo: () => ({ sourceFile: "src" }),
        upload: async () => {
          uploadCalls.push("welocal");
        },
      },
      uploaderNextcloud: {
        getUploadFileInfo: () => ({ sourceFile: "src" }),
        upload: async () => {
          uploadCalls.push("nextcloud");
        },
      },
      doCopyRepeat: false,
      filenameSuffix: ".mp3",
      copyRepeat: jest.fn(),
      unlinkFile: jest.fn(() => uploadCalls.push("unlink")),
      log: () => {},
      logError: () => {},
    });

    recorder.on("finished", async (sourceFile, slot) => {
      handler(sourceFile, slot as TimeSlot);
    });

    // Manually invoke onFinished to simulate ffmpeg completion without
    // actually spawning a subprocess.
    await recorder.onFinished("/tmp/fake.mp3", grid[0], DateTime.now(), 1);
    await waitForPending();

    expect(uploadCalls).toEqual(["welocal", "nextcloud", "unlink"]);
  });
});
