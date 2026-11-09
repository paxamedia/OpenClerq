import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initStore, closeStore } from '../store.js';
import {
  activitiesOf,
  addActivity,
  createRecord,
  deleteRecord,
  findByIdentity,
  getRecord,
  link,
  linksOf,
  listRecords,
  mergeRecords,
  normaliseDomain,
  normalisePhone,
  parseRef,
  resolveRecord,
  updateRecord,
  RecordError,
} from './records.js';

beforeAll(async () => {
  await initStore(':memory:');
});

afterAll(() => closeStore());

describe('identities', () => {
  it('normalise phones and domains', () => {
    expect(normalisePhone('0044 (20) 7946-0018')).toBe('+442079460018');
    expect(normalisePhone('12')).toBeNull();
    expect(normaliseDomain('https://www.Example.co.uk/about?x')).toBe('example.co.uk');
    expect(normaliseDomain('not a domain')).toBeNull();
  });

  it('parse refs', () => {
    expect(parseRef('crm:deal:42')).toEqual({ module: 'crm', type: 'deal', id: '42' });
    expect(() => parseRef('deal:42')).toThrow(RecordError);
  });
});

describe('records', () => {
  it('resolve the same person by any identity, adding new ones', () => {
    const first = resolveRecord({
      type: 'person',
      name: 'Ada Lovelace',
      identities: { emails: ['Ada@Example.com'] },
    });
    expect(first.created).toBe(true);
    const again = resolveRecord({
      type: 'person',
      identities: { emails: ['ada@example.com'], phones: ['+44 20 7946 0018'] },
    });
    expect(again).toMatchObject({ created: false, matchedBy: ['email:ada@example.com'] });
    expect(again.record?.id).toBe(first.record?.id);
    expect(findByIdentity('phone', '0044 20 7946 0018')?.id).toBe(first.record?.id);
    expect(
      resolveRecord({ type: 'person', identities: { emails: ['x@y.zz'] }, create: false }).record
    ).toBeNull();
  });

  it('refuse identities that point at two records, and merge them', () => {
    const a = createRecord({ type: 'person', name: 'A', identities: { emails: ['a@merge.test'] } });
    const b = createRecord({ type: 'person', identities: { emails: ['b@merge.test'] } });
    link('crm:deal:1', b.ref, 'contact');
    expect(() =>
      resolveRecord({ type: 'person', identities: { emails: ['a@merge.test', 'b@merge.test'] } })
    ).toThrow(/different records/);
    const merged = mergeRecords(a.id, b.id);
    expect(merged.emails).toEqual(['a@merge.test', 'b@merge.test']);
    expect(getRecord(b.id)?.id).toBe(a.id);
    expect(linksOf('crm:deal:1')).toMatchObject([{ to: a.ref, kind: 'contact' }]);
    expect(listRecords({ q: 'merge.test' }).map((r) => r.id)).toEqual([a.id]);
  });

  it('keep an organisation and a person apart', () => {
    createRecord({ type: 'organisation', name: 'Acme', identities: { domains: ['acme.test'] } });
    expect(() => resolveRecord({ type: 'person', identities: { domains: ['acme.test'] } })).toThrow(
      /belongs to a organisation|organisation, not a person/
    );
  });

  it('update data and identities', () => {
    const r = createRecord({ type: 'person', data: { a: 1, b: 2 } });
    const u = updateRecord(r.id, {
      name: 'Named',
      data: { b: null, c: 3 },
      add: { emails: ['u@p.test'] },
    });
    expect(u).toMatchObject({ name: 'Named', data: { a: 1, c: 3 }, emails: ['u@p.test'] });
    deleteRecord(r.id);
    expect(getRecord(r.id)).toBeNull();
  });

  it('record activities about refs, newest first', () => {
    const p = createRecord({ type: 'person', name: 'Grace' });
    addActivity({ kind: 'call', summary: 'Called', refs: [p.ref], at: '2026-01-01T10:00:00Z' });
    addActivity({ kind: 'email.sent', summary: 'Emailed', refs: [p.ref, 'outreach:campaign:7'] });
    expect(activitiesOf(p.ref).map((a) => a.name)).toEqual(['Emailed', 'Called']);
    expect(activitiesOf('outreach:campaign:7').map((a) => a.name)).toEqual(['Emailed']);
    expect(() => addActivity({ kind: 'call', summary: 'x', refs: ['core:person:nope'] })).toThrow(
      /No record/
    );
  });
});
