import { useToast } from './Toast';
import { Copy, Key } from 'lucide-react';

interface ApiDocsProps {
    apiToken: string;
}

export function ApiDocs({ apiToken }: ApiDocsProps) {
    const { showToast } = useToast();

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-3 mb-4">
                <Key className="w-7 h-7 text-orange-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">API接口</h2>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                使用以下链接获取纯文本格式的优选IP列表：
            </p>
            <div className="flex items-center gap-2">
                <div className="flex-1 px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded text-sm font-mono text-gray-800 dark:text-gray-200 break-all border border-gray-200 dark:border-gray-600">
                    {window.location.origin}/api/getips?token={apiToken || '请重新登录获取Token'}
                </div>
                <button
                    onClick={() => {
                        const url = `${window.location.origin}/api/getips?token=${apiToken}`;
                        navigator.clipboard.writeText(url).then(() => showToast('API地址已复制', 'success'));
                    }}
                    disabled={!apiToken}
                    className="flex items-center bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md text-sm transition-colors whitespace-nowrap disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                    <Copy className="w-4 h-4 mr-2" />
                    复制
                </button>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-4 mb-2">
                接口支持以下筛选参数：
            </p>
            <ul className="text-sm text-gray-500 dark:text-gray-400 list-disc list-inside space-y-1 mb-4">
                <li><code className="break-all">scene=场景名称</code>: 按场景名称筛选，例如 <code className="break-all">scene=家庭电信</code></li>
                <li><code className="break-all">latency=毫秒数</code>: 筛选延迟小于等于指定值的IP，例如 <code className="break-all">latency=200</code></li>
                <li><code className="break-all">region=地区代码</code>: 按Cloudflare地区代码筛选 (例如: LAX, SJC)，不区分大小写。例如 <code className="break-all">region=SJC</code></li>
                <li><code className="break-all">count=数量</code>: 返回指定数量的IP（按排序结果取前 N 个），例如 <code className="break-all">count=10</code></li>
                <li><code className="break-all">min_speed=Mbps</code>: 只要下载速度不低于该值的IP（未测速的不返回），例如 <code className="break-all">min_speed=30</code></li>
                <li><code className="break-all">min_purity=0-100</code>: 只要纯净度不低于该值的IP（未检测的不返回），例如 <code className="break-all">min_purity=90</code></li>
                <li><code className="break-all">max_age=时长</code>: 只要最近测试过的IP，数字默认为小时，支持 <code className="break-all">h</code>/<code className="break-all">d</code> 后缀，例如 <code className="break-all">max_age=24h</code>、<code className="break-all">max_age=7d</code>（没有测试时间的旧数据不返回，重新保存或复测后会补上）</li>
                <li><code className="break-all">sort=排序方式</code>: <code className="break-all">latency</code>（默认）、<code className="break-all">speed</code>、<code className="break-all">purity</code>、<code className="break-all">score</code>（综合评分：延迟 40% + 下载速度 35% + 纯净度 25%，未测项按 0 计）</li>
                <li><code className="break-all">w_latency</code> / <code className="break-all">w_speed</code> / <code className="break-all">w_purity</code>: 自定义综合评分权重（任意非负数，会自动归一化），仅 <code className="break-all">sort=score</code> 时生效，例如 <code className="break-all">w_speed=60&amp;w_latency=30&amp;w_purity=10</code>；只写其中几项时，未写的按 0 计</li>
                <li><code className="break-all">home=1</code>: 只要家宽 IP（含“疑似家宽”）；<code className="break-all">home=strict</code> 只要上游明确标注为家宽的。需要该 IP 做过纯净度检测，没检测的不返回</li>
                <li><code className="break-all">show_home=1</code>: 输出家宽标记（默认不输出）。家宽的 IP 会在延迟后面多一段 <code className="break-all">|家宽</code>（疑似家宽为 <code className="break-all">|家宽?</code>），需要该 IP 做过纯净度检测；和 <code className="break-all">home</code>（筛选）互相独立，可单独或一起使用</li>
                <li><code className="break-all">format=simple</code>: 精简输出，只保留 <code className="break-all">IP:端口#地区|场景|延迟ms</code>，不追加速度和纯净度字段</li>
            </ul>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                示例:
            </p>
            <div className="px-3 py-2 bg-gray-100 dark:bg-gray-700 rounded text-xs font-mono text-gray-800 dark:text-gray-200 break-all whitespace-pre-wrap border border-gray-200 dark:border-gray-600 mb-2 max-w-full">
                {`${window.location.origin}/api/getips?token=${apiToken || 'TOKEN'}&scene=家庭电信&latency=200&region=SJC&min_speed=30&min_purity=90&sort=score&count=10`}
            </div>
        </div>
    );
}
