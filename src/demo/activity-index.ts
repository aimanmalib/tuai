// Shape of the public activity index (<epochsPath>/<network>/transactions.json), shared by the generator and the page.

export interface ActivityTx {
  /** Step without its epoch or counter, e.g. `claim-first`; the page labels it from lang. */
  step: string;
  epoch: number | null;
  kind: string;
  txid: string | null;
  bytes: number;
  feeSats: number;
  height: number | null;
  utc: string;
  note?: string;
  error?: string;
  /** Explorer link for mined transactions; null for refused ones or when the network has no explorer configured. */
  url: string | null;
}

export interface EpochTotal {
  epoch: number;
  leaves: number;
  /** Sum of every leaf's cumulative amount, in base units, as a decimal string. */
  total: string;
}

export interface ActivityRun {
  /** The deployment folder name, e.g. `chipnet` or `chipnet-push`. */
  run: string;
  pool: string;
  epochs: EpochTotal[];
  transactions: ActivityTx[];
}

export interface ActivityIndex {
  network: string;
  runs: ActivityRun[];
}

const KIND = /^(.*?)(?:-(\d+))?(?:-epoch-(\d+))?$/;

/** Splits a recorded kind such as `claim-first-epoch-1` or `fund-demo-5` into its step and epoch. */
export function parseKind(kind: string): { step: string; epoch: number | null } {
  const m = KIND.exec(kind);
  const step = m?.[1] || kind;
  return { step, epoch: m?.[3] === undefined ? null : Number(m[3]) };
}
