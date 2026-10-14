import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KImage, Rect, Ellipse, Line, Circle, Text, Transformer, Group } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Bbox, Region, SelectionTool } from '../types';
import { badgeCenter, computeMarkerSpec, normBbox } from '../util';

interface Props {
  imageUrl: string;
  regions: Region[];
  selectedId: string | null;
  tool: SelectionTool;
  onSelect: (id: string | null) => void;
  onCreate: (bbox: Bbox) => void;
  onUpdate: (id: string, bbox: Bbox) => void;
  onDelete: (id: string) => void;
  onCopy: (id: string) => void;
  onScale?: (scale: number) => void;
}

type Point = { x: number; y: number };
type Draft = { tool: Exclude<SelectionTool, 'select'>; points: Point[]; now: Point };
const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
};
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function SelectionShape({ bbox, color, draft = false }: { bbox: Bbox; color: string; draft?: boolean }) {
  const w = bbox.x2 - bbox.x1;
  const h = bbox.y2 - bbox.y1;
  const style = { stroke: color, strokeWidth: 2, strokeScaleEnabled: false, fill: 'rgba(0,0,0,0)', dash: draft ? [6, 4] : undefined };
  if (bbox.shape === 'ellipse') return <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} {...style} />;
  if ((bbox.shape === 'polygon' || bbox.shape === 'lasso') && bbox.points?.length) {
    return <Line points={bbox.points.flatMap((p) => [p.x * w, p.y * h])} closed lineJoin="round" {...style} />;
  }
  return <Rect width={w} height={h} {...style} />;
}

export default function AnnotationCanvas(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const shapeRefs = useRef<Record<string, Konva.Group>>({});
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const spaceDown = useRef(false);
  const clicks = useRef<{ previous: Point | null; last: Point | null }>({ previous: null, last: null });
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const W = img?.naturalWidth ?? 0;
  const H = img?.naturalHeight ?? 0;
  const spec = computeMarkerSpec(W || 1000, H || 1000);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const resize = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setImg(null);
    setDraft(null);
    const image = new window.Image();
    image.onload = () => setImg(image);
    image.src = props.imageUrl;
    return () => { image.onload = null; };
  }, [props.imageUrl]);

  useEffect(() => {
    if (!img || !size.w || !size.h) return;
    const scale = Math.min(size.w / W, size.h / H) * 0.92;
    setView({ scale, x: (size.w - W * scale) / 2, y: (size.h - H * scale) / 2 });
    props.onScale?.(scale);
  }, [img, size.w, size.h]);

  useEffect(() => { setDraft(null); clicks.current = { previous: null, last: null }; }, [props.tool]);

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = props.tool === 'select' && props.selectedId ? shapeRefs.current[props.selectedId] : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [props.selectedId, props.regions, props.tool, img]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const toImage = (p: Point): Point => ({
    x: Math.max(0, Math.min(W, (p.x - view.x) / view.scale)),
    y: Math.max(0, Math.min(H, (p.y - view.y) / view.scale)),
  });

  const finish = (current: Draft, endpoint = current.now) => {
    const isPath = current.tool === 'polygon' || current.tool === 'lasso';
    const points = isPath ? current.points : [current.points[0], endpoint];
    const bbox: Bbox = {
      x1: Math.min(...points.map((p) => p.x)), y1: Math.min(...points.map((p) => p.y)),
      x2: Math.max(...points.map((p) => p.x)), y2: Math.max(...points.map((p) => p.y)),
      shape: current.tool,
    };
    const w = bbox.x2 - bbox.x1;
    const h = bbox.y2 - bbox.y1;
    if (w > 8 && h > 8 && (!isPath || points.length >= 3)) {
      if (isPath) {
        const area = Math.abs(points.reduce((sum, p, i) => {
          const next = points[(i + 1) % points.length];
          return sum + p.x * next.y - next.x * p.y;
        }, 0)) / 2;
        if (area < 32) { setDraft(null); return; }
        bbox.points = points.map((p) => ({ x: (p.x - bbox.x1) / w, y: (p.y - bbox.y1) / h }));
      }
      props.onCreate(bbox);
    }
    setDraft(null);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.code === 'Space') { spaceDown.current = true; e.preventDefault(); }
      if (draft && ['Escape', 'Enter', 'Backspace', 'Delete'].includes(e.key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') setDraft(null);
        else if (e.key === 'Enter' && draft.tool === 'polygon') finish(draft);
        else if (draft.tool === 'polygon') setDraft(draft.points.length > 1 ? { ...draft, points: draft.points.slice(0, -1) } : null);
      }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') spaceDown.current = false; };
    const blur = () => { spaceDown.current = false; pan.current = null; setDraft(null); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [draft, props.onCreate]);

  // Finish drags even when the pointer is released outside the canvas.
  useEffect(() => {
    const release = (e: MouseEvent) => {
      pan.current = null;
      if (!draft || draft.tool === 'polygon' || e.button !== 0) return;
      const stage = stageRef.current;
      stage?.setPointersPositions(e);
      const p = stage?.getPointerPosition();
      const endpoint = p ? toImage(p) : draft.now;
      finish(draft.tool === 'lasso' ? { ...draft, points: [...draft.points, endpoint] } : draft, endpoint);
    };
    window.addEventListener('mouseup', release);
    return () => window.removeEventListener('mouseup', release);
  }, [draft, view, W, H, props.onCreate]);

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const pointTo = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };
    const scale = Math.max(0.05, Math.min(8, view.scale * (e.evt.deltaY > 0 ? 1 / 1.08 : 1.08)));
    setView({ scale, x: pointer.x - pointTo.x * scale, y: pointer.y - pointTo.y * scale });
    props.onScale?.(scale);
  };

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    setMenu(null);
    if (spaceDown.current || e.evt.button === 1) {
      pan.current = { sx: e.evt.clientX, sy: e.evt.clientY, ox: view.x, oy: view.y };
      e.evt.preventDefault();
      return;
    }
    if (e.evt.button !== 0 || !img) return;
    const stage = stageRef.current;
    const p = stage?.getPointerPosition();
    if (!p) return;
    if (props.tool === 'select') {
      if (e.target.name() === 'bg' || e.target === stage) props.onSelect(null);
      return;
    }
    const raw = { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
    if (raw.x < 0 || raw.y < 0 || raw.x > W || raw.y > H) return;
    const ip = toImage(p);
    clicks.current = { previous: clicks.current.last, last: ip };
    if (props.tool === 'polygon' && draft) {
      if (draft.points.length >= 3 && distance(ip, draft.points[0]) * view.scale < 10) { finish(draft); return; }
      if (distance(ip, draft.points[draft.points.length - 1]) * view.scale < 2) return;
      setDraft({ ...draft, points: [...draft.points, ip], now: ip });
    } else setDraft({ tool: props.tool, points: [ip], now: ip });
  };

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    if (pan.current) {
      const current = pan.current;
      setView((v) => ({ ...v, x: current.ox + e.evt.clientX - current.sx, y: current.oy + e.evt.clientY - current.sy }));
      return;
    }
    const p = stageRef.current?.getPointerPosition();
    if (!draft || !p) return;
    const now = toImage(p);
    setDraft({ ...draft, now, points: draft.tool === 'lasso' && distance(now, draft.points[draft.points.length - 1]) * view.scale >= 2 ? [...draft.points, now] : draft.points });
  };

  const hints: Record<SelectionTool, string> = {
    select: '拖动选区移动 · 拖动控制点缩放 · 滚轮缩放 · 空格拖动画布',
    rect: '按住并拖动绘制矩形 · Esc 取消',
    ellipse: '按住并拖动绘制椭圆 / 圆形 · Esc 取消',
    polygon: '逐点点击 · 点击起点、双击或 Enter 闭合 · 退格撤回一点 · Esc 取消',
    lasso: '按住并沿对象轮廓拖动 · 松开自动闭合 · Esc 取消',
  };

  return (
    <div className="canvas-wrap" ref={wrapRef} style={{ cursor: props.tool === 'select' ? 'default' : 'crosshair' }}>
      <Stage ref={stageRef} width={size.w} height={size.h} scaleX={view.scale} scaleY={view.scale} x={view.x} y={view.y}
        onWheel={onWheel} onMouseDown={onMouseDown} onMouseMove={onMouseMove}
        onDblClick={() => {
          const { previous, last } = clicks.current;
          // Konva emits dblclick for rapid clicks anywhere on the same image node.
          if (draft?.tool === 'polygon' && previous && last && distance(previous, last) * view.scale < 8) finish(draft);
        }} onContextMenu={(e) => e.evt.preventDefault()}>
        <Layer>{img && <KImage image={img} width={W} height={H} name="bg" />}</Layer>
        <Layer>
          {props.regions.map((r) => {
            const b = { ...r.bbox, ...normBbox(r.bbox) };
            const w = b.x2 - b.x1;
            const h = b.y2 - b.y1;
            const bc = badgeCenter(b, spec, W, H);
            return <Group key={r.id}>
              <Group x={b.x1} y={b.y1}
                ref={(node) => { if (node) shapeRefs.current[r.id] = node; else delete shapeRefs.current[r.id]; }}
                draggable={props.tool === 'select' && !spaceDown.current}
                onClick={() => { if (props.tool === 'select') props.onSelect(r.id); }}
                onDragStart={() => props.onSelect(r.id)}
                onDragEnd={(e) => {
                  const node = e.target;
                  props.onUpdate(r.id, { ...b, x1: node.x(), y1: node.y(), x2: node.x() + w, y2: node.y() + h });
                }}
                onTransformEnd={(e) => {
                  const node = e.target;
                  const nw = Math.max(10, w * node.scaleX());
                  const nh = Math.max(10, h * node.scaleY());
                  node.scaleX(1); node.scaleY(1);
                  props.onUpdate(r.id, { ...b, x1: node.x(), y1: node.y(), x2: node.x() + nw, y2: node.y() + nh });
                }}
                onContextMenu={(e) => {
                  e.evt.preventDefault(); props.onSelect(r.id);
                  setMenu({ x: e.evt.clientX, y: e.evt.clientY, id: r.id });
                }}>
                <SelectionShape bbox={b} color={r.color} />
              </Group>
              <Circle x={bc.cx} y={bc.cy} radius={bc.r} fill={r.color} listening={false} />
              <Text x={bc.cx - bc.r} y={bc.cy - bc.r} width={bc.r * 2} height={bc.r * 2} text={String(r.idx)} fontSize={spec.fontSize} fontStyle="bold" fill="#fff" align="center" verticalAlign="middle" listening={false} />
            </Group>;
          })}
          {draft && (draft.tool === 'polygon' || draft.tool === 'lasso' ? <Group listening={false}>
            <Line points={[...draft.points, draft.now].flatMap((p) => [p.x, p.y])} closed={draft.tool === 'lasso'} stroke="#4F8CFF" strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} lineJoin="round" />
            {draft.tool === 'polygon' && draft.points.map((p, i) => <Circle key={i} x={p.x} y={p.y} radius={(i === 0 ? 5 : 3) / view.scale} fill={i === 0 ? '#4F8CFF' : '#fff'} stroke="#4F8CFF" strokeWidth={1} strokeScaleEnabled={false} />)}
          </Group> : (() => {
            const b = normBbox({ x1: draft.points[0].x, y1: draft.points[0].y, x2: draft.now.x, y2: draft.now.y });
            return <Group x={b.x1} y={b.y1} listening={false}><SelectionShape bbox={{ ...b, shape: draft.tool }} color="#4F8CFF" draft /></Group>;
          })())}
          <Transformer ref={trRef} rotateEnabled={false} flipEnabled={false} keepRatio={false} borderStroke="#4F8CFF" anchorStroke="#4F8CFF" anchorSize={9} ignoreStroke boundBoxFunc={(old, next) => next.width < 10 || next.height < 10 ? old : next} />
        </Layer>
      </Stage>
      <div className="canvas-tool-hint">{hints[props.tool]}</div>
      {menu && <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <button className="ctx-item" onClick={() => { props.onCopy(menu.id); setMenu(null); }}>复制区域</button>
        <button className="ctx-item danger" onClick={() => { props.onDelete(menu.id); setMenu(null); }}>删除区域</button>
      </div>}
    </div>
  );
}
