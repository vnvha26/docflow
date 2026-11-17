export type JsonSchema =
  | { type: 'string'; enum?: readonly string[]; maxLength?: number; format?: 'date' }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'null' }
  | { type: 'array'; items: JsonSchema; maxItems?: number }
  | { type: 'object'; properties: Readonly<Record<string, JsonSchema>>; required?: readonly string[]; additionalProperties?: false }
  | { anyOf: readonly JsonSchema[] };

const MAX_ERRORS = 20;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) return;
  if ('anyOf' in schema) {
    if (!schema.anyOf.some((option) => { const inner: string[] = []; check(option, value, path, inner); return inner.length === 0; })) {
      errors.push(`${path}: không khớp lựa chọn nào`);
    }
    return;
  }
  const actual = kindOf(value);
  switch (schema.type) {
    case 'string':
      if (actual !== 'string') { errors.push(`${path}: cần string, nhận ${actual}`); return; }
      if (schema.enum && !schema.enum.includes(value as string)) errors.push(`${path}: ngoài danh sách cho phép`);
      if (schema.maxLength !== undefined && (value as string).length > schema.maxLength) errors.push(`${path}: dài quá ${schema.maxLength} ký tự`);
      if (schema.format === 'date' && !isDate(value as string)) errors.push(`${path}: không phải ngày YYYY-MM-DD`);
      return;
    case 'number':
    case 'integer':
      if (actual !== 'number' || !Number.isFinite(value)) { errors.push(`${path}: cần ${schema.type}, nhận ${actual}`); return; }
      if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: cần số nguyên`);
      if (schema.minimum !== undefined && (value as number) < schema.minimum) errors.push(`${path}: nhỏ hơn ${schema.minimum}`);
      if (schema.maximum !== undefined && (value as number) > schema.maximum) errors.push(`${path}: lớn hơn ${schema.maximum}`);
      return;
    case 'boolean':
    case 'null':
      if (actual !== schema.type) errors.push(`${path}: cần ${schema.type}, nhận ${actual}`);
      return;
    case 'array':
      if (actual !== 'array') { errors.push(`${path}: cần array, nhận ${actual}`); return; }
      if (schema.maxItems !== undefined && (value as unknown[]).length > schema.maxItems) errors.push(`${path}: quá ${schema.maxItems} phần tử`);
      (value as unknown[]).forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
      return;
    case 'object': {
      if (actual !== 'object') { errors.push(`${path}: cần object, nhận ${actual}`); return; }
      const record = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) errors.push(`${path}.${key}: thiếu`);
      for (const [key, item] of Object.entries(record)) {
        const property = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (property) check(property, item, `${path}.${key}`, errors);
        else if (schema.additionalProperties === false) errors.push(`${path}: có trường lạ`);
      }
      return;
    }
  }
}

export function validateJson(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, '$', errors);
  return errors.slice(0, MAX_ERRORS);
}

export const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
