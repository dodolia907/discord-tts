import { ApiException, type CoreV1Api, type V1Pod } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { createEngines } from "./engines.js";
import { buildPod, inspectPod, KubernetesPods } from "./k8s.js";
import { UserFacingError } from "./session.js";

const engines = createEngines({ openjtalkImage: "oj:1", voicevoxImage: "vv:1", voicevoxSpeaker: 3 });
const engine = engines.openjtalk;
const owner = { name: "bot-abc", uid: "uid-1" };
const signal = new AbortController().signal;

const readyPod: V1Pod = {
  status: { phase: "Running", podIP: "10.9.0.5", conditions: [{ type: "Ready", status: "True" }] },
};
const quotaError = () => new ApiException(403, "forbidden", "exceeded quota: discord-tts", {});

function setup(api: Partial<Record<keyof CoreV1Api, unknown>>, capacityWaitMs = 0) {
  const fake = {
    createNamespacedPod: vi.fn(async () => ({ metadata: { name: "tts-1" } })),
    readNamespacedPod: vi.fn(async () => readyPod),
    deleteNamespacedPod: vi.fn(async () => ({})),
    listNamespacedPod: vi.fn(async () => ({ items: [] as V1Pod[] })),
    ...api,
  };
  const log = vi.fn();
  const pods = new KubernetesPods(fake as unknown as CoreV1Api, "ns", owner, log, { pollMs: 0, capacityWaitMs });
  return { pods, fake, log };
}

describe("buildPod", () => {
  it.each(Object.values(engines))("hardens and limits the $name Pod", (e) => {
    const pod = buildPod("123", e, owner);
    const container = pod.spec!.containers[0]!;

    expect(pod.spec!.automountServiceAccountToken).toBe(false);
    expect(pod.spec!.securityContext!.runAsNonRoot).toBe(true);
    expect(container.securityContext!.capabilities!.drop).toEqual(["ALL"]);
    expect(container.resources).toEqual(e.resources);
    expect(container.image).toBe(e.image);
    expect(pod.metadata!.labels!["discord-tts/guild"]).toBe("123");
    expect(pod.metadata!.ownerReferences).toEqual([{ apiVersion: "v1", kind: "Pod", name: "bot-abc", uid: "uid-1" }]);
  });
});

describe("inspectPod", () => {
  it.each<[string, V1Pod, ReturnType<typeof inspectPod>]>([
    ["no status", {}, { state: "pending" }],
    ["ready", readyPod, { state: "ready", ip: "10.9.0.5" }],
    [
      "ready but no IP",
      { status: { conditions: [{ type: "Ready", status: "True" }] } },
      { state: "pending" },
    ],
    [
      "unschedulable",
      { status: { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] } },
      { state: "unschedulable" },
    ],
    ["failed", { status: { phase: "Failed" } }, { state: "failed", reason: "phase Failed" }],
    [
      "image pull backoff",
      {
        status: {
          containerStatuses: [{ state: { waiting: { reason: "ImagePullBackOff" } } } as never],
        },
      },
      { state: "failed", reason: "ImagePullBackOff" },
    ],
    [
      "a pull in progress is not fatal",
      { status: { containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } } as never] } },
      { state: "pending" },
    ],
  ])("%s", (_name, pod, expected) => {
    expect(inspectPod(pod)).toEqual(expected);
  });
});

describe("KubernetesPods", () => {
  it("returns the Pod's address once Ready", async () => {
    const { pods } = setup({});
    await expect(pods.start("g", engine, signal)).resolves.toEqual({
      name: "tts-1",
      baseUrl: "http://10.9.0.5:8080",
    });
  });

  it("retries a quota rejection while a previous Pod terminates", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce({ metadata: { name: "tts-1" } });
    const { pods } = setup({ createNamespacedPod: create }, 1_000);

    await expect(pods.start("g", engine, signal)).resolves.toMatchObject({ name: "tts-1" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports a lasting quota rejection to the user", async () => {
    const { pods, fake } = setup({ createNamespacedPod: vi.fn().mockRejectedValue(quotaError()) });

    await expect(pods.start("g", engine, signal)).rejects.toBeInstanceOf(UserFacingError);
    expect(fake.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("does not mistake other API errors for a capacity problem", async () => {
    const error = new ApiException(403, "forbidden", "pods is forbidden", {});
    const { pods } = setup({ createNamespacedPod: vi.fn().mockRejectedValue(error) });

    await expect(pods.start("g", engine, signal)).rejects.toBe(error);
  });

  it("deletes the Pod and tells the user when it stays unschedulable", async () => {
    const { pods, fake } = setup({
      readNamespacedPod: vi.fn(async () => ({
        status: { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }] },
      })),
    });

    await expect(pods.start("g", engine, signal)).rejects.toBeInstanceOf(UserFacingError);
    expect(fake.deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("deletes the Pod when it fails to start", async () => {
    const { pods, fake } = setup({ readNamespacedPod: vi.fn(async () => ({ status: { phase: "Failed" } })) });

    await expect(pods.start("g", engine, signal)).rejects.toThrow("phase Failed");
    expect(fake.deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("deletes the Pod when startup is aborted", async () => {
    const abort = new AbortController();
    const { pods, fake } = setup({
      readNamespacedPod: vi.fn(async () => {
        abort.abort();
        return {};
      }),
    });

    await expect(pods.start("g", engine, abort.signal)).rejects.toThrow();
    expect(fake.deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });

  it("reads the container's restart count", async () => {
    const read = vi.fn(async () => ({ status: { containerStatuses: [{ restartCount: 2 }] } }));
    const { pods } = setup({ readNamespacedPod: read });

    await expect(pods.restartCount("p")).resolves.toBe(2);
  });

  it("treats deleting a missing Pod as success", async () => {
    const del = vi.fn().mockRejectedValue(new ApiException(404, "not found", "", {}));
    const { pods } = setup({ deleteNamespacedPod: del });

    await expect(pods.delete("gone")).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("retries a failed delete, then gives up", async () => {
    const del = vi.fn().mockRejectedValue(new Error("api down"));
    const { pods } = setup({ deleteNamespacedPod: del });

    await expect(pods.delete("p")).rejects.toThrow("api down");
    expect(del).toHaveBeenCalledTimes(3);
  });

  it("removes every leftover Pod and logs individual failures", async () => {
    const del = vi.fn(async ({ name }: { name: string }) => {
      if (name === "a") throw new Error("api down");
      return {};
    });
    const list = vi.fn(async () => ({ items: [{ metadata: { name: "a" } }, { metadata: { name: "b" } }] }));
    const { pods, log } = setup({ deleteNamespacedPod: del, listNamespacedPod: list });

    await pods.deleteAll();

    expect(list).toHaveBeenCalledWith(expect.objectContaining({ labelSelector: expect.stringContaining("tts") }));
    expect(del.mock.calls.map(([arg]) => arg.name)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(log).toHaveBeenCalledTimes(1);
  });
});
