import type { QcIdentity } from '../types';

export interface IdentityDecision {
  verdict: 'pass' | 'mid' | 'fail';
  shouldRepair: boolean;
}

/** §4.7.1 三档分流（纯函数，供单测）：≥pass 通过；[mid, pass) 中分；< mid 不达标 */
export function decideIdentity(sim: number, passThreshold: number, midThreshold: number, autoFaceRepair: boolean): IdentityDecision {
  if (sim >= passThreshold) return { verdict: 'pass', shouldRepair: false };
  if (sim >= midThreshold) return { verdict: 'mid', shouldRepair: !!autoFaceRepair };
  return { verdict: 'fail', shouldRepair: false };
}

export function skippedIdentity(reason: string, passThreshold: number, midThreshold: number): QcIdentity {
  return { status: 'skipped', sim: null, reason, passThreshold, midThreshold };
}
