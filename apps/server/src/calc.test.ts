import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { calcNextTo, chooseCalcPath } from './calc.js';
import type { Env } from './env.js';

const exec = path.join('/opt/openclerq', 'clerq-server');
const beside = path.join('/opt/openclerq', 'clerq-calc');
const yes = () => true;
const no = () => false;

describe('the calculation engine next to the server', () => {
  it('is used when CLERQ_CALC_PATH is not set', () => {
    const env: Env = {};
    expect(chooseCalcPath(env, exec, yes, 'linux')).toBe('next-to-executable');
    expect(env.CLERQ_CALC_PATH).toBe(beside);
  });

  it('only counts a file that exists, and looks for exactly clerq-calc', () => {
    const looked: string[] = [];
    const env: Env = {};
    expect(
      chooseCalcPath(env, exec, (f) => {
        looked.push(f);
        return false;
      })
    ).toBe('default');
    expect(env.CLERQ_CALC_PATH).toBeUndefined();
    expect(looked).toEqual([beside]);
  });

  it('is not used when CLERQ_CALC_PATH is set', () => {
    const env: Env = { CLERQ_CALC_PATH: '/custom/clerq-calc' };
    expect(chooseCalcPath(env, exec, yes)).toBe('env');
    expect(env.CLERQ_CALC_PATH).toBe('/custom/clerq-calc');
  });

  it('treats a blank CLERQ_CALC_PATH as unset', () => {
    const env: Env = { CLERQ_CALC_PATH: '  ' };
    expect(chooseCalcPath(env, exec, yes, 'linux')).toBe('next-to-executable');
    expect(env.CLERQ_CALC_PATH).toBe(beside);
  });

  it('knows the Windows name', () => {
    expect(calcNextTo(path.join('C:\\x', 'clerq-server.exe'), 'win32', yes)).toMatch(
      /clerq-calc\.exe$/
    );
    expect(calcNextTo(exec, 'linux', no)).toBeNull();
  });
});
