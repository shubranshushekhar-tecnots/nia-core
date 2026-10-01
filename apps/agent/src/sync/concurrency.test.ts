import { describe, expect, it } from "vitest";
import { KeyedSemaphore, Semaphore } from "./concurrency.js";

describe("Semaphore", () => {
  it("runs up to the limit concurrently, queues the rest", async () => {
    const sem = new Semaphore(2);
    const order: string[] = [];

    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    const thirdDone = sem.acquire().then((release) => {
      order.push("third-acquired");
      release();
    });

    order.push("before-release");
    release1();
    release2();
    await thirdDone;

    expect(order).toEqual(["before-release", "third-acquired"]);
  });

  it("serializes with limit 1", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    const task = async (id: number) => {
      const release = await sem.acquire();
      order.push(id);
      await new Promise((r) => setTimeout(r, 1));
      release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("KeyedSemaphore", () => {
  it("limits per key independently", async () => {
    const sem = new KeyedSemaphore(1);
    const releaseA = await sem.acquire("host-a:1433");

    let bAcquired = false;
    const bPromise = sem.acquire("host-b:1433").then((release) => {
      bAcquired = true;
      release();
    });
    await bPromise;
    expect(bAcquired).toBe(true);

    releaseA();
  });

  it("serializes acquisitions sharing the same key", async () => {
    const sem = new KeyedSemaphore(1);
    const order: string[] = [];

    const releaseA = await sem.acquire("same-key");
    const secondAcquire = sem.acquire("same-key").then((release) => {
      order.push("second");
      release();
    });

    order.push("first-still-held");
    releaseA();
    await secondAcquire;

    expect(order).toEqual(["first-still-held", "second"]);
  });
});
