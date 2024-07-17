import BroadcastArchive from "./src/broadcast-archive";
import { toDateTime } from "./src/helper/date-time";

// This is used to batch download audio files from the web.
// You need to provide a json file with one record per item
const archive = new BroadcastArchive({
  inputFile: "archive/broadcastArchive.json",
  outDir: "archive/mp3",
  parserMapping: {
    primaryId: "top.Topic_ID",
    url: "r.SourceURL",
    title: "top.Title",
    description: "top.Description",
    body: "r.rText",
    date: "p.Date",
    time: "p.Time",
    broadcast: "pk.rname",
    category: "c.category",
    forename: "rc.ForeName",
    surname: "rc.SurName",
  },
  skip: ["\n\n\t\t\n"],
  // Set this to try downloading again without e.g. a subdomain
  fallbackStrip: "zappa.",
});

archive
  .parseInputFile()
  .downloadFiles(
    toDateTime("2001-01-01T00:00:00"),
    toDateTime("2024-12-31T00:00:00")
  )
  .then((response) => {
    console.log("[Archive] finished.");
  });

// BroadcastArchive will be used to add TimeSlots to BroadcastSchedule
// in a future version
