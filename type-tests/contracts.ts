import type { DatabaseStore } from '../src/core/database.js';
import type { Engine } from '../src/core/engine.js';
import type { Entity, Node } from '../src/core/model.js';
import type { NormalizedServerConfig } from '../src/server/config.js';

// Проверяется компилятором, функция не запускается и не попадает в пакет.
export async function contracts(engine: Engine, entity: Entity, store: DatabaseStore, config: NormalizedServerConfig, node: Node): Promise<void> {
  const ref = await engine.mutate(entity, 'update', '1', {});
  void ref.value;
  const name: string = await engine.mutate(entity, 'update', '1', {}, () => 'name');
  void name;
  // @ts-expect-error Без преобразователя возвращается Ref, а не произвольный тип.
  await engine.mutate<string>(entity, 'update', '1', {});
  await store.update((_draft, before) => {
    // @ts-expect-error Массивы исходного снимка доступны только для чтения.
    before.items?.push({ id: 'forged' });
    if (before.items?.[0]) {
      // @ts-expect-error Вложенные поля исходной записи тоже доступны только для чтения.
      before.items[0].id = 'forged';
    }
  });
  if (config.storage === 'file') {
    const path: string = config.database.source;
    void path;
    // @ts-expect-error Файловое хранилище принимает путь, а не данные.
    config.database.source = { items: [] };
  } else {
    const rows = config.database.source.items;
    void rows;
    // @ts-expect-error Источник файлов в памяти — массив, а не путь.
    if (config.files) config.files.source = 'uploads';
  }
  if (node.relation) {
    const keys: string[] = [node.source, node.target];
    void keys;
  }
}
