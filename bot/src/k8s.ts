import { setTimeout as sleep } from "node:timers/promises";
import { ApiException, type CoreV1Api, type V1Pod } from "@kubernetes/client-node";
import type { Engine } from "./engines.js";
import { type PodController, type RunningPod, UserFacingError } from "./session.js";

const COMPONENT_SELECTOR = "app.kubernetes.io/name=discord-tts,app.kubernetes.io/component=tts";
const POLL_INTERVAL_MS = 1_000;
/** A Pod from a session that just ended may still hold the quota or the CPU for a moment. */
const CAPACITY_WAIT_MS = 20_000;
const DELETE_ATTEMPTS = 3;
const FATAL_WAITING_REASONS = new Set([
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CrashLoopBackOff",
]);

const NO_CAPACITY = "サーバーのリソースが不足しているため起動できません。他の読み上げが終わってからお試しください。";

export function buildPod(
  guildId: string,
  engine: Engine,
  owner: { name: string; uid: string },
): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      generateName: `tts-${engine.name}-`,
      labels: {
        "app.kubernetes.io/name": "discord-tts",
        "app.kubernetes.io/component": "tts",
        "discord-tts/engine": engine.name,
        "discord-tts/guild": guildId,
      },
      // Lets the garbage collector remove the Pod if the bot's Pod goes away without cleaning up.
      ownerReferences: [{ apiVersion: "v1", kind: "Pod", name: owner.name, uid: owner.uid }],
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      terminationGracePeriodSeconds: 1,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65532,
        runAsGroup: 65532,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "tts",
          image: engine.image,
          ...(engine.command && { command: engine.command }),
          imagePullPolicy: "IfNotPresent",
          ports: [{ containerPort: engine.port }],
          env: [{ name: "HOME", value: "/tmp" }],
          resources: engine.resources,
          readinessProbe: {
            httpGet: { path: engine.readinessPath, port: engine.port as never },
            periodSeconds: 1,
            failureThreshold: 3,
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
        },
      ],
      volumes: [{ name: "tmp", emptyDir: { sizeLimit: "256Mi" } }],
    },
  };
}

export type PodProgress =
  | { state: "ready"; ip: string }
  | { state: "pending" }
  | { state: "unschedulable" }
  | { state: "failed"; reason: string };

export function inspectPod(pod: V1Pod): PodProgress {
  const status = pod.status;
  if (status?.phase === "Failed" || status?.phase === "Succeeded") {
    return { state: "failed", reason: `phase ${status.phase}` };
  }
  const waiting = status?.containerStatuses?.[0]?.state?.waiting?.reason;
  if (waiting && FATAL_WAITING_REASONS.has(waiting)) {
    return { state: "failed", reason: waiting };
  }
  const condition = (type: string) => status?.conditions?.find((c) => c.type === type);
  if (condition("Ready")?.status === "True" && status?.podIP) {
    return { state: "ready", ip: status.podIP };
  }
  const scheduled = condition("PodScheduled");
  if (scheduled?.status === "False" && scheduled.reason === "Unschedulable") {
    return { state: "unschedulable" };
  }
  return { state: "pending" };
}

function isQuotaRejection(error: unknown): boolean {
  return error instanceof ApiException && error.code === 403 && String(error.body).includes("exceeded quota");
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiException && error.code === 404;
}

export class KubernetesPods implements PodController {
  constructor(
    private readonly api: CoreV1Api,
    private readonly namespace: string,
    private readonly owner: { name: string; uid: string },
    private readonly log: (message: string, error?: unknown) => void,
    private readonly timing = { pollMs: POLL_INTERVAL_MS, capacityWaitMs: CAPACITY_WAIT_MS },
  ) {}

  async start(guildId: string, engine: Engine, signal: AbortSignal): Promise<RunningPod> {
    const name = await this.create(guildId, engine, signal);
    try {
      const ip = await this.waitReady(name, engine, signal);
      return { name, baseUrl: `http://${ip}:${engine.port}` };
    } catch (error) {
      await this.delete(name).catch((e) => this.log(`failed to delete Pod ${name}`, e));
      throw error;
    }
  }

  async delete(name: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.api.deleteNamespacedPod({ name, namespace: this.namespace, gracePeriodSeconds: 1 });
        return;
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        if (attempt >= DELETE_ATTEMPTS) {
          throw error;
        }
        await sleep(this.timing.pollMs);
      }
    }
  }

  async restartCount(name: string): Promise<number> {
    const pod = await this.api.readNamespacedPod({ name, namespace: this.namespace });
    return pod.status?.containerStatuses?.[0]?.restartCount ?? 0;
  }

  /** Removes the Pods left over from a previous run. */
  async deleteAll(): Promise<void> {
    const pods = await this.api.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: COMPONENT_SELECTOR,
    });
    const results = await Promise.allSettled(pods.items.map((pod) => this.delete(pod.metadata!.name!)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.log("failed to delete a leftover Pod", result.reason);
      }
    }
  }

  private async create(guildId: string, engine: Engine, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.timing.capacityWaitMs;
    for (;;) {
      try {
        const created = await this.api.createNamespacedPod({
          namespace: this.namespace,
          body: buildPod(guildId, engine, this.owner),
        });
        return created.metadata!.name!;
      } catch (error) {
        if (!isQuotaRejection(error)) {
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new UserFacingError(NO_CAPACITY);
        }
        await sleep(this.timing.pollMs, undefined, { signal });
      }
    }
  }

  private async waitReady(name: string, engine: Engine, signal: AbortSignal): Promise<string> {
    const started = Date.now();
    for (;;) {
      signal.throwIfAborted();
      const progress = inspectPod(await this.api.readNamespacedPod({ name, namespace: this.namespace }));
      const elapsed = Date.now() - started;
      switch (progress.state) {
        case "ready":
          return progress.ip;
        case "failed":
          throw new Error(`Pod ${name} failed: ${progress.reason}`);
        case "unschedulable":
          if (elapsed >= this.timing.capacityWaitMs) {
            throw new UserFacingError(NO_CAPACITY);
          }
          break;
        case "pending":
          break;
      }
      if (elapsed >= engine.startTimeoutMs) {
        throw new Error(`Pod ${name} was not Ready within ${engine.startTimeoutMs} ms`);
      }
      await sleep(this.timing.pollMs, undefined, { signal });
    }
  }
}
