export interface Config {
  /** Nebius Estate (plugins/nebius-estate-backend/src/lib/config.ts). Backend only. */
  nebiusEstate?: {
    /** Read-only checkout of this repository. */
    repoRoot?: string;
    /** Plugin start-up waits for the first sync (scripted checks and tests). Default false: the first sync runs in the background. */
    waitForFirstSync?: boolean;
    access?: {
      roles?: {
        name: string;
        /** User or group entity refs. */
        principals: string[];
        /** nebius.* permission names, or '*'. */
        permissions: string[];
        /** Nebius project ids, or '*'. */
        projects?: string[];
      }[];
    };
    nebius?: {
      tenantId?: string;
      projects?: { id: string; name?: string; regions?: string[] }[];
      /** Name of an environment variable with comma-separated project ids, added to `projects`. */
      projectIdsEnv?: string;
      /**
       * Defaults to https://api.nebius.cloud. Another value is accepted only for a
       * loopback endpoint on a loopback-only backend (the e2e stub).
       * @visibility backend
       */
      apiEndpoint?: string;
      /** GPU telemetry from Nebius Monitoring (PromQL read API), per listed project. */
      monitoring?: {
        /** Default true. */
        enabled?: boolean;
        /**
         * Defaults to https://read.monitoring.api.nebius.cloud; another value only on a loopback-only backend.
         * @visibility backend
         */
        endpoint?: string;
      };
      /** Nebius Observability Logs (Loki-compatible read API), per listed project: the Logs page. */
      logging?: {
        /** Default true. */
        enabled?: boolean;
        /**
         * Defaults to https://read.logging.api.nebius.cloud; another value only on a loopback-only backend.
         * @visibility backend
         */
        endpoint?: string;
      };
      /** Nebius Audit Logs (tenant audit events, per region): the Logs page. Needs auditlogs.audit-event-viewer on the tenant. */
      audit?: {
        /** Default true. */
        enabled?: boolean;
        /**
         * Defaults to https://audit.api.nebius.cloud; another value only on a loopback-only backend.
         * @visibility backend
         */
        endpoint?: string;
      };
      /** Live list prices from the Nebius billing calculator (estimate-batch). */
      pricing?: {
        /** Default true. */
        enabled?: boolean;
        /** Three-letter currency, default usd. */
        currency?: string;
        /** Cache per spec and project, default 30. */
        cacheMinutes?: number;
        /** Try the contract price first (needs billing-group access); default true. */
        tryContractPrice?: boolean;
      };
      /**
       * Names of the environment variables holding the credentials, never the values.
       * @visibility backend
       */
      auth?: {
        tokenEnv?: string;
        serviceAccount?: { idEnv: string; publicKeyIdEnv: string; privateKeyFileEnv?: string; privateKeyEnv?: string };
      };
      syncIntervalMinutes?: number;
      timeoutMs?: number;
      /** Requests in flight per host, 1–16 (default 12); 429s are retried with backoff. */
      maxConcurrency?: number;
      /** Minimum spacing between request starts per host, ms (default 20, i.e. at most 50 per second). */
      minRequestIntervalMs?: number;
      /**
       * Every Nth scheduled sync also reads the slow-tier lists (platforms, quotas, VPC pools, DNS, KMS, …);
       * start-up and "Sync now" always read everything. Default 4.
       */
      fullSyncEvery?: number;
      /**
       * Lifecycle-aware fast re-sync: while an MK8s cluster or node group is PROVISIONING / UPDATING / DELETING,
       * or a VM is CREATING / STARTING / UPDATING / STOPPING / DELETING, one extra sync of the fast tier
       * (VMs, clusters, node groups, discovered clusters' Kubernetes API) runs this many seconds after the last
       * sync. 60–900 (never sooner than the "Sync now" cooldown); 0 turns it off. Default 120.
       */
      fastSyncSeconds?: number;
      /** Fast re-syncs in a row before falling back to the normal cadence (shown on Integrations). 1–200, default 30 (about an hour). */
      fastSyncMax?: number;
      /**
       * List the tenant's projects (needs tenant-level `viewer`) and show the ones not in scope as a hint.
       * The configured project list stays the scope. Default false.
       */
      discoverProjects?: boolean;
      /**
       * Managed Kubernetes clusters in the configured projects are discovered and connected
       * automatically (endpoint and CA from the MK8s API, the portal's Nebius token as bearer).
       */
      mk8s?: {
        /** Default true. */
        discover?: boolean;
        /** Control-plane endpoint to use: public (default) or private (backend inside the VPC). */
        endpoint?: 'public' | 'private';
        /** Drop a cluster that has been missing for this many consecutive syncs (default 3). */
        forgetAfterSyncs?: number;
        /** e2e stub only: a loopback base standing in for every discovered endpoint; refused unless the backend is loopback-only. */
        testEndpoint?: string;
      };
    };
    /** Explicitly configured clusters (e.g. non-Nebius); MK8s clusters are discovered without this. */
    kubernetes?: {
      clusters?: {
        name: string;
        /** https only. */
        url: string;
        /**
         * Environment variable holding a read-only service-account token.
         * @visibility backend
         */
        tokenEnv: string;
        /** @visibility backend */
        caFile?: string;
        mk8sClusterId?: string;
        dashboardUrl?: string;
        namespaces?: string[];
      }[];
    };
    prometheus?: {
      /** https, or http on localhost (port-forward). */
      url: string;
      /** @visibility backend */
      tokenEnv?: string;
      timeoutMs?: number;
    };
    billing?: {
      maxImportBytes?: number;
      /** Pull FOCUS files from the billing export bucket (Object Storage, read-only, SigV4). */
      export?: {
        /** Names of environment variables, never the values. */
        bucketEnv: string;
        regionEnv: string;
        prefixEnv?: string;
        /** @visibility backend */
        accessKeyIdEnv: string;
        /** @visibility backend */
        secretAccessKeyEnv: string;
        /**
         * Loopback test endpoint only (e2e stub); production uses https://storage.<region>.nebius.cloud.
         * @visibility backend
         */
        endpoint?: string;
      };
    };
    commercial?: {
      /** Rate book for run-rate and provisioning estimates; default: the first by id. */
      defaultRateBook?: string;
    };
    /** AI services (Token Factory, Hugging Face): names of environment variables, never the values. */
    ai?: {
      tokenFactory?: {
        /** e.g. NEBIUS_API_KEY. @visibility backend */
        apiKeyEnv: string;
        /** Loopback test endpoint only (e2e stub). @visibility backend */
        endpoint?: string;
      };
      huggingface?: {
        /** e.g. HF_TOKEN. @visibility backend */
        tokenEnv: string;
        /** Loopback test endpoint only (e2e stub). @visibility backend */
        endpoint?: string;
        /** Most models checked per sync (default 20). */
        maxModels?: number;
      };
    };
    /**
     * Advisory budgets compared with reported BilledCost.
     *
     * @deprecated Budgets are entered on the Budgets & credits page (stored in the portal database).
     * Budgets still listed here are shown there read-only, next to the stored ones; nothing is
     * imported. Re-enter each on that page and remove this key. Kept for backward compatibility.
     */
    budgets?: {
      id: string;
      project?: string;
      /** Decimal string. */
      amount: string;
      currency: string;
      /** YYYY-MM */
      period: string;
      source: string;
    }[];
  };
}
