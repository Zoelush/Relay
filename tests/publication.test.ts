import test from "node:test";
import assert from "node:assert/strict";
import { CoalescedPublisher } from "../server/publication";

test("publication acknowledges its own batch, retains hints arriving in flight, and retries after failure", async () => {
  let started!: () => void, release!: () => void;
  const firstStarted = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const batches: string[][] = [];
  const publisher = new CoalescedPublisher(async (ids) => {
    batches.push(ids);
    if (batches.length === 1) {
      started();
      await gate;
    }
    if (ids.includes("fail")) throw new Error("offline");
  }, 0);
  const first = publisher.publish("first");
  await firstStarted;
  let secondAcknowledged = false;
  const second = publisher.publish("second").then(() => {
    secondAcknowledged = true;
  });
  release();
  await first;
  assert.equal(secondAcknowledged, false);
  await second;
  assert.deepEqual(batches, [["first"], ["second"]]);
  await assert.rejects(publisher.publish("fail"), /offline/);
  await publisher.publish("recovered");
  assert.deepEqual(batches.at(-1), ["recovered"]);
});
