export type SnapshotValue = JsonPrimitive | RecordSnapshot | readonly SnapshotValue[];
export interface RecordSnapshot {
  readonly [key: string]: SnapshotValue;
}
export type DatabaseSnapshot = Readonly<Record<string, readonly RecordSnapshot[]>>;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type DatabaseId = number | string;
export type DatabaseRecord = JsonObject;
export type DatabaseData = Record<string, DatabaseRecord[]>;

export type QueryValue = string | string[] | undefined;
export type Query = Record<string, QueryValue>;
