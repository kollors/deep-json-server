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

export async function readonlyContracts(store: DatabaseStore, engine: Engine, entity: Entity): Promise<void> {
  const snapshot = await store.read();
  // @ts-expect-error Чтение не предоставляет изменяемый массив.
  snapshot.items?.push({ id: 'forged' });
  // @ts-expect-error Подтверждённое состояние нельзя заменить в обход транзакции.
  store.database.data = {};
  // @ts-expect-error Контейнер состояния тоже доступен только для чтения.
  store.database = { data: {} };
  const ref = await engine.mutate(entity, 'update', '1', {});
  // @ts-expect-error Результат мутации представляет подтверждённый снимок.
  ref.value.id = 'forged';
  const value: number = await store.update(async () => 1);
  const name: string = await engine.mutate(entity, 'update', '1', {}, async () => 'name');
  void [value, name];
}

export function schemaContracts(): void {
  // @ts-expect-error Тип значения ограничен допустимыми типами JSON Schema.
  const invalidType: import('../src/core/schema.js').ValidationSchema = { type: 'strnig' };
  // @ts-expect-error required содержит имена полей.
  const invalidRequired: import('../src/core/schema.js').ValidationSchema = { required: 42 };
  // @ts-expect-error Неизвестное свойство не скрывается индексной сигнатурой.
  const typo: import('../src/openapi/types.js').OpenapiSchema = { type: 'string', minLenght: 1 };
  // @ts-expect-error OpenAPI 3.0 не поддерживает массив типов.
  const typeArray: import('../src/openapi/types.js').OpenapiSchema = { type: ['string', 'null'] };
  // @ts-expect-error Ответ требует описание.
  const response: import('../src/openapi/types.js').OpenapiResponse = { description: 42 };
  const extension: import('../src/openapi/types.js').OpenapiSchema = { type: 'string', 'x-example': true };
  void [invalidType, invalidRequired, typo, typeArray, response, extension];
}
