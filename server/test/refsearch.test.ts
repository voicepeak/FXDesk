import { describe, expect, it } from 'vitest';
import { buildSearchUrl, isAllowedImageUrl, upgradeCdnUrl } from '../src/refsearch/xhs';

describe('参考搜索：小红书 URL 工具', () => {
  it('搜索链接对关键词做 URL 编码', () => {
    const url = buildSearchUrl('明日香 场照');
    expect(url).toBe('https://www.xiaohongshu.com/search_result?keyword=%E6%98%8E%E6%97%A5%E9%A6%99%20%E5%9C%BA%E7%85%A7&source=web_explore_feed');
  });

  it('只放行 https 的小红书 CDN 域名', () => {
    expect(isAllowedImageUrl('https://sns-img-qc.xhscdn.com/abc.jpg')).toBe(true);
    expect(isAllowedImageUrl('https://sns-webpic-qc.xhscdn.com/2026/a/b!nd_dft_wlteh_webp_3')).toBe(true);
    expect(isAllowedImageUrl('https://ci.xiaohongshu.com/abc.png')).toBe(true);
    expect(isAllowedImageUrl('http://sns-img-qc.xhscdn.com/abc.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://evil.com/sns-img-qc.xhscdn.com/abc.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://xhscdn.com.evil.com/abc.jpg')).toBe(false);
    expect(isAllowedImageUrl('not-a-url')).toBe(false);
  });

  it('imageView2 缩略图放大到 1440，已足够大的与无参数的保持不变', () => {
    expect(upgradeCdnUrl('https://sns-img-qc.xhscdn.com/abc?imageView2/2/w/360/format/webp')).toBe(
      'https://sns-img-qc.xhscdn.com/abc?imageView2/2/w/1440/format/webp'
    );
    expect(upgradeCdnUrl('https://sns-img-qc.xhscdn.com/abc?imageView2/2/w/1440/format/webp')).toBe(
      'https://sns-img-qc.xhscdn.com/abc?imageView2/2/w/1440/format/webp'
    );
    expect(upgradeCdnUrl('https://sns-webpic-qc.xhscdn.com/2026/x/y!nd_dft_wlteh_webp_3')).toBe(
      'https://sns-webpic-qc.xhscdn.com/2026/x/y!nd_dft_wlteh_webp_3'
    );
  });
});
