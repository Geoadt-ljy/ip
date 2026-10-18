import { useState, useEffect } from 'react';
import { CloudflareIps, getCloudflareIps, syncCloudflareIps } from '../api';
import { Cloud, RotateCw } from 'lucide-react';
import { useToast } from './Toast';

interface CloudflareIpListProps {
    onDataLoaded: (data: CloudflareIps) => void;
}

export function CloudflareIpList({ onDataLoaded }: CloudflareIpListProps) {
    const [cfIps, setCfIps] = useState<CloudflareIps | null>(null);
    const [loading, setLoading] = useState(false);
    const { showToast } = useToast();

    const loadData = async (retryCount = 3) => {
        setLoading(true);
        for (let attempt = 1; attempt <= retryCount; attempt++) {
            try {
                const cfData = await getCloudflareIps();
                setCfIps(cfData);
                if (cfData) {
                    onDataLoaded(cfData);
                }
                setLoading(false);
                return; // 成功则直接返回
            } catch (err) {
                console.error(`获取 Cloudflare IP 失败（第 ${attempt}/${retryCount} 次尝试）`, err);
                if (attempt < retryCount) {
                    // 指数退避：1s, 2s, 3s
                    const delay = attempt * 1000;
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    // 最后一次也失败，才提示用户
                    showToast('获取Cloudflare IP段失败，可点击"同步最新IP段"手动重试', 'error');
                }
            } finally {
                if (attempt === retryCount) {
                    setLoading(false);
                }
            }
        }
    };

    const handleSync = async () => {
        setLoading(true);
        try {
            const data = await syncCloudflareIps();
            setCfIps(data);
            onDataLoaded(data);
            showToast('同步成功', 'success');
        } catch (err) {
            showToast('同步Cloudflare IP失败', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
    }, []);

    // 点击网段标签：通知“IP优选测速”把网段加入自定义 IP 输入框
    const addCidrs = (cidrs: string[]) => {
        window.dispatchEvent(new CustomEvent('ip-main:add-cidr', { detail: { cidrs } }));
    };

    const renderChips = (list?: string[]) => (list && list.length > 0 ? list.map(cidr => (
        <button
            type="button"
            key={cidr}
            onClick={() => addCidrs([cidr])}
            title="点击加入自定义 IP 输入框"
            className="bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 px-2 py-1 rounded text-xs font-mono hover:bg-blue-100 hover:text-blue-700 dark:hover:bg-blue-900/50 dark:hover:text-blue-300 transition-colors"
        >{cidr}</button>
    )) : <p className="text-gray-400 text-xs italic">暂无数据</p>);

    const addAllButton = (list?: string[]) => (list && list.length > 0 ? (
        <button
            type="button"
            onClick={() => addCidrs(list)}
            className="px-2 py-0.5 text-xs font-medium text-blue-600 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-800/50"
            title="把本组全部网段加入自定义 IP 输入框"
        >全部加入</button>
    ) : null);

    return (
        <div className="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6 mb-8">
            <div className="flex items-center gap-4 mb-6">
                <Cloud className="w-7 h-7 text-blue-500" />
                <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-200">IP段</h2>
                <button 
                    onClick={handleSync}
                    disabled={loading}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-600 bg-blue-100 rounded-full hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-800/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="从上游同步最新的IP段"
                >
                    <RotateCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span>{loading ? '同步中...' : '同步最新IP段'}</span>
                </button>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="font-bold text-gray-600 dark:text-gray-300">CF官方IP段</h3>
                    <span className="text-xs text-gray-400 dark:text-gray-500">cloudflare官方公布的ip段，覆盖最全</span>
                    {addAllButton(cfIps?.ipv4_cidrs)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {renderChips(cfIps?.ipv4_cidrs)}
                  </div>
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <h3 className="font-bold text-gray-600 dark:text-gray-300">CM整理IP段</h3>
                    <span className="text-xs text-gray-400 dark:text-gray-500">民间大佬维护IP段，测速成功率高</span>
                    {addAllButton(cfIps?.cm_cidrs)}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {renderChips(cfIps?.cm_cidrs)}
                  </div>
                </div>
            </div>
        </div>
    );
}