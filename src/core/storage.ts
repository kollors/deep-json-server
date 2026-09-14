export type Storage = 'file' | 'memory';
export type Source<S extends Storage, T> = S extends 'file' ? string : T;
