import { modelsStatus, detectFaces, embedFace, cosineSimilarity, pickFacePair, type Face } from './faces';
import { decideIdentity, skippedIdentity } from './identity';
import type { AppSettings } from '../settings';
import type { QcIdentity } from '../types';
import { logLine } from '../logger';

export interface IdentityCheckResult {
  identity: QcIdentity;
  shouldRepair: boolean;
  pair: { orig: Face; res: Face } | null;
}

/** §4.7.1 身份检测编排（模型缺失/无人脸/异常 → skipped 转人工，不阻断） */
export async function runIdentityCheck(origAbs: string, resAbs: string, settings: AppSettings): Promise<IdentityCheckResult> {
  const pass = settings.qcIdentityPass;
  const mid = settings.qcIdentityMid;
  const st = modelsStatus();
  if (!st.ok) {
    return { identity: skippedIdentity('model_missing', pass, mid), shouldRepair: false, pair: null };
  }
  try {
    const [of, rf] = await Promise.all([detectFaces(origAbs), detectFaces(resAbs)]);
    const pair = pickFacePair(of, rf);
    if (!pair) {
      return { identity: skippedIdentity('no_face', pass, mid), shouldRepair: false, pair: null };
    }
    const [eo, er] = await Promise.all([embedFace(origAbs, pair.orig.kps), embedFace(resAbs, pair.res.kps)]);
    const sim = cosineSimilarity(eo, er);
    const d = decideIdentity(sim, pass, mid, settings.qcAutoFaceRepair);
    const identity: QcIdentity = {
      status: d.verdict,
      sim: Number(sim.toFixed(4)),
      reason: null,
      passThreshold: pass,
      midThreshold: mid,
      afterRepair: null,
    };
    return { identity, shouldRepair: d.shouldRepair, pair };
  } catch (e) {
    logLine('warn', `身份检测异常，转人工目检：${String(e)}`);
    return { identity: skippedIdentity('error', pass, mid), shouldRepair: false, pair: null };
  }
}
