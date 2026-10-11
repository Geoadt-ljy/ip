import {
    getColoName,
    getColoText,
    getFlagUrl,
    isWindowsPlatform,
} from '../utils/colo';

interface RegionDisplayProps {
    /** Cloudflare colo 代码，例如 "NRT" */
    colo?: string;
    /** 额外的 className，会附加到外层 span */
    className?: string;
    /** 国旗图片尺寸，仅在 Windows 下生效 */
    flagSize?: 'xs' | 'sm' | 'md';
}

/**
 * 统一的地区显示组件。
 * - Windows 平台：用 <img> 加载 ipdata.co 国旗图片 + 纯文本 (Windows 浏览器对 emoji 旗帜渲染为两个字母)
 * - 其他平台：直接渲染 getColoName 的字符串 (含 emoji 旗帜)
 */
export function RegionDisplay({ colo, className = '', flagSize = 'xs' }: RegionDisplayProps) {
    if (!colo) {
        return <span className={className}>-</span>;
    }

    const useFlag = isWindowsPlatform();
    const flagUrl = useFlag ? getFlagUrl(colo) : null;
    const text = useFlag ? getColoText(colo) : getColoName(colo);

    const sizeClass =
        flagSize === 'md' ? 'w-5 h-3.5' : flagSize === 'sm' ? 'w-4 h-3' : 'w-3.5 h-2.5';

    return (
        <span className={`inline-flex items-center gap-1.5 ${className}`}>
            {flagUrl && (
                <img
                    src={flagUrl}
                    alt=""
                    className={`${sizeClass} object-cover rounded-sm flex-shrink-0`}
                    loading="lazy"
                    decoding="async"
                />
            )}
            <span>{text}</span>
        </span>
    );
}
