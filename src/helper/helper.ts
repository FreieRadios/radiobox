import { DateTime } from "luxon";

export const vd = (v: any, keys?: boolean): void => {
  if (keys && typeof v === "object") {
    v = Object.keys(v);
  }
  console.log("--------- [zappi] ---------");
  // @ts-ignore
  console.log(new Error().stack.split("\n")[2].trim());
  console.dir(v, { depth: 10 });
};
export const replaceRangeArrays = (block: string) => {
  return block
    .replace("[1-12]", "[1,2,3,4,5,6,7,8,9,10,11,12]")
    .replace("[1-5]", "[1,2,3,4,5]")
    .replace("M:", '"monthsOfYear": ')
    .replace("D:", '"nthWeekdaysOfMonth": ')
    .replace("H:", '"hoursOfDay": ')
    .replace("R:", '"repeatOffset": ')
    .replace("I:", '"info": ')
    .replace("O:", '"overrides": ');
};
export const parseJsonBlock = (block) => {
  let json = {};
  try {
    json = JSON.parse("{" + block + "}");
  } catch (e) {
    console.error(e);
    console.error(block);
  }
  return json;
};
export const nthOfMonth = (timeSlot: DateTime) => {
  let nth = Math.ceil(timeSlot.c.day / 7);
  return (((nth + 90) % 100) - 10) % 10;
};
export const isLastOfMonth = (timeSlot: DateTime) => {
  return timeSlot.month !== timeSlot.plus({ days: 7 }).month;
};
