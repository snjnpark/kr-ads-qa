// Names accepted only when reading older saved settings; no sample data is distributed.
export const LEGACY_DATASET_NAMES = ["demo", "api", "products"] as const;
export type LegacyDataset = (typeof LEGACY_DATASET_NAMES)[number];
