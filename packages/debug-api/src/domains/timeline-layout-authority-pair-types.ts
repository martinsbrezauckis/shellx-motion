export type ImmutableJsonPairStep = "receipt" | "authority" | "journal";

export interface ImmutableJsonPairCommitHooks {
  beforeCommitStep?: (step: ImmutableJsonPairStep) => void | Promise<void>;
  afterMemberLink?: (
    step: Exclude<ImmutableJsonPairStep, "journal">,
  ) => void | Promise<void>;
  beforeRollbackUnlink?: (
    step: Exclude<ImmutableJsonPairStep, "journal">,
  ) => void | Promise<void>;
  afterRollbackUnlink?: (
    step: Exclude<ImmutableJsonPairStep, "journal">,
  ) => void | Promise<void>;
  /** Test-only fault/interleaving hook immediately before the journal reader-admission link. */
  beforeJournalAdmissionLink?: () => void | Promise<void>;
}

export interface ImmutableJsonPairDescriptor {
  key: string;
  recordKind: string;
  outputLineage: unknown;
  receipt: unknown;
  receiptMaximumBytes: number;
  authority: unknown;
  authorityMaximumBytes: number;
  hooks?: ImmutableJsonPairCommitHooks;
}

export interface ImmutableJsonPairReadDescriptor {
  key: string;
  recordKinds: readonly string[];
  outputLineage: unknown;
  receiptMaximumBytes: number;
  authorityMaximumBytes: number;
}

export interface ImmutableJsonPair {
  recordKind: string;
  receipt: unknown;
  authority: unknown;
  journalPath: string;
}

/** Opaque host transaction state between pre-install pair preparation and journal admission. */
export interface PreparedImmutableJsonPair {
  readonly __layoutAuthorityPreparedPair: unique symbol;
}

export interface HostQuiescentPairRecoveryAdmission {
  readonly kind: "host-operator-quiescent";
}
