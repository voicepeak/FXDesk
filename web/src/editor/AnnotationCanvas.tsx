import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Image as KImage, Rect, Circle, Text, Transformer, Group } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Bbox, Region } from '../types';
import { badgeCenter, computeMarkerSpec, normBbox } from '../util';

interface Props {
  imageUrl: string;
  regions: Region[];
  selectedId: string | null;
  tool: 'select' | 'rect';
  onSelect: (id: string | null) => void;
  onCreate: (bbox: Bbox) => void;
  onUpdate: (id: string, bbox: Bbox) => void;
  onDelete: (id: string) => void;
  onCopy: (id: string) => void;
  onScale?: (scale: number) => void;
}

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
}

export default function AnnotationCanvas(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const shapeRefs = useRef<Record<string, Konva.Rect>>({});

  const [size, setSize] = useState({ w: 800, h: 600 });
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [draft, setDraft] = useState<{ start: { x: number; y: number }; now: { x: number; y: number } } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const spaceDown = useRef(false);
  const pan = useRef<{ active: boolean; sx: number; sy: number; ox: number; oy: number }>({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  const W = img?.naturalWidth ?? 0;
  const H = img?.naturalHeight ?? 0;
  const spec = computeMarkerSpec(W || 1000, H || 1000);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const image = new window.Image();
    image.src = props.imageUrl;
    image.onload = () => setImg(image);
    return () => {
      image.onload = null;
    };
  }, [props.imageUrl]);

  useEffect(() => {
    if (!img || !size.w) return;
    const scale = Math.min(size.w / img.naturalWidth, size.h / img.naturalHeight) * 0.92;
    setView({ scale, x: (size.w - img.naturalWidth * scale) / 2, y: (size.h - img.naturalHeight * scale) / 2 });
    props.onScale?.(scale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, size.w, size.h]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target)) {
        spaceDown.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    const tr = trRef.current;
    if (!tr) return;
    const node = props.selectedId ? shapeRefs.current[props.selectedId] : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [props.selectedId, props.regions, img]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const toImage = (p: { x: number; y: number }) => ({ x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale });

  const onWheel = (e: KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const oldScale = view.scale;
    const pointTo = { x: (pointer.x - view.x) / oldScale, y: (pointer.y - view.y) / oldScale };
    const factor = 1.08;
    let newScale = e.evt.deltaY > 0 ? oldScale / factor : oldScale * factor;
    newScale = Math.max(0.1, Math.min(8, newScale));
    setView({ scale: newScale, x: pointer.x - pointTo.x * newScale, y: pointer.y - pointTo.y * newScale });
    props.onScale?.(newScale);
  };

  const onMouseDown = (e: KonvaEventObject<MouseEvent>) => {
    if (menu) setMenu(null);
    const stage = stageRef.current;
    if (!stage) return;
    if (spaceDown.current || e.evt.button === 1) {
      pan.current = { active: true, sx: e.evt.clientX, sy: e.evt.clientY, ox: view.x, oy: view.y };
      return;
    }
    if (e.evt.button !== 0) return;
    if (props.tool === 'rect') {
      const p = stage.getPointerPosition();
      if (!p) return;
      const ip = toImage(p);
      setDraft({ start: ip, now: ip });
    } else {
      const targetName = (e.target as Konva.Node).attrs?.name;
      if (targetName === 'bg' || e.target === stage) props.onSelect(null);
    }
  };

  const onMouseMove = (e: KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (pan.current.active) {
      const dx = e.evt.clientX - pan.current.sx;
      const dy = e.evt.clientY - pan.current.sy;
      setView((v) => ({ ...v, x: pan.current.ox + dx, y: pan.current.oy + dy }));
      return;
    }
    if (draft) {
      const p = stage.getPointerPosition();
      if (!p) return;
      setDraft({ ...draft, now: toImage(p) });
    }
  };

  const onMouseUp = () => {
    pan.current.active = false;
    if (draft) {
      const b = normBbox({ x1: draft.start.x, y1: draft.start.y, x2: draft.now.x, y2: draft.now.y });
      if (b.x2 - b.x1 > 8 && b.y2 - b.y1 > 8 && W && H) {
        props.onCreate({
          x1: Math.max(0, b.x1),
          y1: Math.max(0, b.y1),
          x2: Math.min(W, b.x2),
          y2: Math.min(H, b.y2),
        });
      }
      setDraft(null);
    }
  };

  const cursor = pan.current.active || spaceDown.current ? 'grab' : props.tool === 'rect' ? 'crosshair' : 'default';

  return (
    <div className="canvas-wrap" ref={wrapRef} style={{ cursor }}>
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        scaleX={view.scale}
        scaleY={view.scale}
        x={view.x}
        y={view.y}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        <Layer>
          {img && <KImage image={img} x={0} y={0} width={W} height={H} name="bg" />}
        </Layer>
        <Layer>
          {draft &&
            (() => {
              const b = normBbox({ x1: draft.start.x, y1: draft.start.y, x2: draft.now.x, y2: draft.now.y });
              return <Rect x={b.x1} y={b.y1} width={b.x2 - b.x1} height={b.y2 - b.y1} stroke="#4F8CFF" strokeWidth={spec.stroke} dash={[10, 6]} fill="rgba(79,140,255,0.12)" />;
            })()}
          {props.regions.map((r) => {
            const b = normBbox(r.bbox);
            const w = b.x2 - b.x1;
            const h = b.y2 - b.y1;
            const bc = badgeCenter(b, spec, W, H);
            return (
              <Group key={r.id}>
                <Rect
                  ref={(node) => {
                    if (node) shapeRefs.current[r.id] = node;
                    else delete shapeRefs.current[r.id];
                  }}
                  x={b.x1}
                  y={b.y1}
                  width={w}
                  height={h}
                  stroke={r.color}
                  strokeWidth={spec.stroke}
                  fill={r.color}
                  opacity={props.selectedId === r.id ? 1 : 0.92}
                  fillOpacity={0.12}
                  draggable={props.tool === 'select' && !spaceDown.current}
                  onClick={() => props.onSelect(r.id)}
                  onTap={() => props.onSelect(r.id)}
                  onDragStart={() => props.onSelect(r.id)}
                  onDragEnd={(e) => {
                    const node = e.target as Konva.Rect;
                    props.onUpdate(r.id, {
                      x1: node.x(),
                      y1: node.y(),
                      x2: node.x() + w,
                      y2: node.y() + h,
                    });
                  }}
                  onTransformEnd={(e) => {
                    const node = e.target as Konva.Rect;
                    const nw = Math.max(10, node.width() * node.scaleX());
                    const nh = Math.max(10, node.height() * node.scaleY());
                    node.scaleX(1);
                    node.scaleY(1);
                    props.onUpdate(r.id, { x1: node.x(), y1: node.y(), x2: node.x() + nw, y2: node.y() + nh });
                  }}
                  onContextMenu={(e) => {
                    e.evt.preventDefault();
                    props.onSelect(r.id);
                    setMenu({ x: e.evt.clientX, y: e.evt.clientY, id: r.id });
                  }}
                />
                <Circle cx={bc.cx} cy={bc.cy} radius={bc.r} fill={r.color} listening={false} />
                <Text
                  x={bc.cx - bc.r}
                  y={bc.cy - bc.r}
                  width={bc.r * 2}
                  height={bc.r * 2}
                  text={String(r.idx)}
                  fontSize={spec.fontSize}
                  fontStyle="bold"
                  fill="#FFFFFF"
                  align="center"
                  verticalAlign="middle"
                  listening={false}
                />
              </Group>
            );
          })}
          <Transformer
            ref={trRef}
            rotateEnabled={false}
            keepRatio={false}
            borderStroke="#4F8CFF"
            anchorStroke="#4F8CFF"
            anchorSize={9}
            ignoreStroke
            boundBoxFunc={(_oldBox, newBox) => {
              const nb = { ...newBox };
              nb.width = Math.max(10, nb.width);
              nb.height = Math.max(10, nb.height);
              return nb;
            }}
          />
        </Layer>
      </Stage>
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="ctx-item"
            onClick={() => {
              props.onCopy(menu.id);
              setMenu(null);
            }}
          >
            复制区域
          </button>
          <button
            className="ctx-item danger"
            onClick={() => {
              props.onDelete(menu.id);
              setMenu(null);
            }}
          >
            删除区域
          </button>
        </div>
      )}
    </div>
  );
}
