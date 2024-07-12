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
export const nthOfMonth = (timeSlot: DateTime) => {
  let nth = Math.ceil(timeSlot.day / 7);
  return (((nth + 90) % 100) - 10) % 10;
};
export const isLastOfMonth = (timeSlot: DateTime) => {
  return timeSlot.month !== timeSlot.plus({ days: 7 }).month;
};
export const sleep = (ms: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};
export const timeFormats = {
  machine: "yyyyMMdd-HHmmss",
  human: "yyyy-MM-dd HH:mm",
};
