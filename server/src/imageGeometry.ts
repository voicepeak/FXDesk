// Common aspect ratios supported by the Gemini image API.
// https://ai.google.dev/gemini-api/docs/image-generation#aspect_ratios_and_image_size
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export function closestAspectRatio(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('无法根据无效图片尺寸确定输出比例');
  }
  const ratio = width / height;
  return ASPECT_RATIOS.reduce((best, candidate) => {
    const distance = (value: string) => {
      const [w, h] = value.split(':').map(Number);
      return Math.abs(Math.log(ratio / (w / h)));
    };
    return distance(candidate) < distance(best) ? candidate : best;
  });
}

export function canvasConstraint(aspectRatio: string, references: boolean): string {
  return `【主图与画布】第一张输入图片是待编辑主图${references ? '，其余图片依次为参考图1、参考图2等，仅用于指定特效、道具和样式参考，不得使用参考图的画布、人物姿势或构图替换主图' : ''}。输出画布宽高比为 ${aspectRatio}，保持主图人物的正常身体比例、位置、姿态和透视，不得拉伸或压扁画面，不得添加黑边、白边或其他补边。`;
}
