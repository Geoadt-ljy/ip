import { timingSafeEqual } from '../_lib/auth';
import { compositeScore, normalizeWeights, DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from '../_lib/score';
import { isHome, classifyHome } from '../_lib/residential';

interface Env {
    IP_KV: KVNamespace;
    APITOKEN?: string;
}

// Cloudflare colo 代码到地区名称的映射表 (复制自 src/utils/colo.ts，修改时请同步更新前端)
const coloMap: { [key: string]: string } = {
    'SJC': '🇺🇸 圣何塞', 'LAX': '🇺🇸 洛杉矶', 'SEA': '🇺🇸 西雅图', 'SFO': '🇺🇸 旧金山', 'DFW': '🇺🇸 达拉斯',
    'ORD': '🇺🇸 芝加哥', 'IAD': '🇺🇸 华盛顿', 'ATL': '🇺🇸 亚特兰大', 'MIA': '🇺🇸 迈阿密', 'DEN': '🇺🇸 丹佛',
    'PHX': '🇺🇸 凤凰城', 'BOS': '🇺🇸 波士顿', 'EWR': '🇺🇸 纽瓦克', 'JFK': '🇺🇸 纽约', 'LAS': '🇺🇸 拉斯维加斯',
    'MSP': '🇺🇸 明尼阿波利斯', 'DTW': '🇺🇸 底特律', 'PHL': '🇺🇸 费城', 'CLT': '🇺🇸 夏洛特', 'SLC': '🇺🇸 盐湖城',
    'PDX': '🇺🇸 波特兰', 'SAN': '🇺🇸 圣地亚哥', 'TPA': '🇺🇸 坦帕', 'IAH': '🇺🇸 休斯顿', 'MCO': '🇺🇸 奥兰多',
    'AUS': '🇺🇸 奥斯汀', 'BNA': '🇺🇸 纳什维尔', 'RDU': '🇺🇸 罗利', 'IND': '🇺🇸 印第安纳波利斯', 'CMH': '🇺🇸 哥伦布',
    'MCI': '🇺🇸 堪萨斯城', 'OMA': '🇺🇸 奥马哈', 'ABQ': '🇺🇸 阿尔伯克基', 'OKC': '🇺🇸 俄克拉荷马城', 'MEM': '🇺🇸 孟菲斯',
    'JAX': '🇺🇸 杰克逊维尔', 'RIC': '🇺🇸 里士满', 'BUF': '🇺🇸 布法罗', 'PIT': '🇺🇸 匹兹堡', 'CLE': '🇺🇸 克利夫兰',
    'CVG': '🇺🇸 辛辛那提', 'MKE': '🇺🇸 密尔沃基', 'STL': '🇺🇸 圣路易斯', 'SAT': '🇺🇸 圣安东尼奥', 'HNL': '🇺🇸 檀香山',
    'ANC': '🇺🇸 安克雷奇', 'SMF': '🇺🇸 萨克拉门托', 'ONT': '🇺🇸 安大略', 'OAK': '🇺🇸 奥克兰',
    'HKG': '🇭🇰 香港', 'TPE': '🇨🇳 台北', 'TSA': '🇨🇳 台北松山', 'KHH': '🇨🇳 高雄',
    'NRT': '🇯🇵 东京成田', 'HND': '🇯🇵 东京羽田', 'KIX': '🇯🇵 大阪关西', 'ITM': '🇯🇵 大阪伊丹', 'NGO': '🇯🇵 名古屋',
    'FUK': '🇯🇵 福冈', 'CTS': '🇯🇵 札幌', 'OKA': '🇯🇵 冲绳',
    'ICN': '🇰🇷 首尔仁川', 'GMP': '🇰🇷 首尔金浦', 'PUS': '🇰🇷 釜山',
    'SIN': '🇸🇬 新加坡', 'BKK': '🇹🇭 曼谷', 'DMK': '🇹🇭 曼谷廊曼', 'KUL': '🇲🇾 吉隆坡', 'CGK': '🇮🇩 雅加达',
    'MNL': '🇵🇭 马尼拉', 'CEB': '🇵🇭 宿务', 'HAN': '🇻🇳 河内', 'SGN': '🇻🇳 胡志明', 'DAD': '🇻🇳 岘港',
    'RGN': '🇲🇲 仰光', 'PNH': '🇰🇭 金边', 'REP': '🇰🇭 暹粒', 'VTE': '🇱🇦 万象',
    'BOM': '🇮🇳 孟买', 'DEL': '🇮🇳 新德里', 'MAA': '🇮🇳 金奈', 'BLR': '🇮🇳 班加罗尔', 'CCU': '🇮🇳 加尔各答',
    'HYD': '🇮🇳 海得拉巴', 'AMD': '🇮🇳 艾哈迈达巴德', 'COK': '🇮🇳 科钦', 'PNQ': '🇮🇳 浦那', 'GOI': '🇮🇳 果阿',
    'CMB': '🇱🇰 科伦坡', 'DAC': '🇧🇩 达卡', 'KTM': '🇳🇵 加德满都', 'ISB': '🇵🇰 伊斯兰堡', 'KHI': '🇵🇰 卡拉奇', 'LHE': '🇵🇰 拉合尔',
    'LHR': '🇬🇧 伦敦希思罗', 'LGW': '🇬🇧 伦敦盖特威克', 'STN': '🇬🇧 伦敦斯坦斯特德', 'LTN': '🇬🇧 伦敦卢顿', 'MAN': '🇬🇧 曼彻斯特', 'EDI': '🇬🇧 爱丁堡', 'BHX': '🇬🇧 伯明翰',
    'CDG': '🇫🇷 巴黎戴高乐', 'ORY': '🇫🇷 巴黎奥利', 'MRS': '🇫🇷 马赛', 'LYS': '🇫🇷 里昂', 'NCE': '🇫🇷 尼斯',
    'FRA': '🇩🇪 法兰克福', 'MUC': '🇩🇪 慕尼黑', 'TXL': '🇩🇪 柏林', 'BER': '🇩🇪 柏林勃兰登堡', 'HAM': '🇩🇪 汉堡', 'DUS': '🇩🇪 杜塞尔多夫', 'CGN': '🇩🇪 科隆', 'STR': '🇩🇪 斯图加特',
    'AMS': '🇳🇱 阿姆斯特丹', 'BRU': '🇧🇪 布鲁塞尔', 'LUX': '🇱🇺 卢森堡',
    'ZRH': '🇨🇭 苏黎世', 'GVA': '🇨🇭 日内瓦', 'BSL': '🇨🇭 巴塞尔',
    'VIE': '🇦🇹 维也纳', 'PRG': '🇨🇿 布拉格', 'BUD': '🇭🇺 布达佩斯', 'WAW': '🇵🇱 华沙', 'KRK': '🇵🇱 克拉科夫',
    'MXP': '🇮🇹 米兰马尔彭萨', 'LIN': '🇮🇹 米兰利纳特', 'FCO': '🇮🇹 罗马', 'VCE': '🇮🇹 威尼斯', 'NAP': '🇮🇹 那不勒斯', 'FLR': '🇮🇹 佛罗伦萨', 'BGY': '🇮🇹 贝加莫',
    'MAD': '🇪🇸 马德里', 'BCN': '🇪🇸 巴塞罗那', 'PMI': '🇪🇸 帕尔马', 'AGP': '🇪🇸 马拉加', 'VLC': '🇪🇸 瓦伦西亚', 'SVQ': '🇪🇸 塞维利亚', 'BIO': '🇪🇸 毕尔巴鄂',
    'LIS': '🇵🇹 里斯本', 'OPO': '🇵🇹 波尔图', 'FAO': '🇵🇹 法鲁',
    'DUB': '🇮🇪 都柏林', 'CPH': '🇩🇰 哥本哈根', 'ARN': '🇸🇪 斯德哥尔摩', 'GOT': '🇸🇪 哥德堡',
    'OSL': '🇳🇴 奥斯陆', 'BGO': '🇳🇴 卑尔根', 'HEL': '🇫🇮 赫尔辛基', 'RIX': '🇱🇻 里加', 'TLL': '🇪🇪 塔林', 'VNO': '🇱🇹 维尔纽斯',
    'ATH': '🇬🇷 雅典', 'SKG': '🇬🇷 塞萨洛尼基', 'SOF': '🇧🇬 索非亚', 'OTP': '🇷🇴 布加勒斯特', 'BEG': '🇷🇸 贝尔格莱德', 'ZAG': '🇭🇷 萨格勒布', 'LJU': '🇸🇮 卢布尔雅那',
    'KBP': '🇺🇦 基辅', 'IEV': '🇺🇦 基辅茹良尼', 'ODS': '🇺🇦 敖德萨',
    'SVO': '🇷🇺 莫斯科谢列梅捷沃', 'DME': '🇷🇺 莫斯科多莫杰多沃', 'VKO': '🇷🇺 莫斯科伏努科沃', 'LED': '🇷🇺 圣彼得堡',
    'IST': '🇹🇷 伊斯坦布尔', 'SAW': '🇹🇷 伊斯坦布尔萨比哈', 'ESB': '🇹🇷 安卡拉', 'AYT': '🇹🇷 安塔利亚', 'ADB': '🇹🇷 伊兹密尔',
    'TLV': '🇮🇱 特拉维夫', 'AMM': '🇯🇴 安曼', 'BEY': '🇱🇧 贝鲁特', 'BAH': '🇧🇭 巴林', 'KWI': '🇰🇼 科威特',
    'DXB': '🇦🇪 迪拜', 'AUH': '🇦🇪 阿布扎比', 'SHJ': '🇦🇪 沙迦', 'DOH': '🇶🇦 多哈', 'MCT': '🇴🇲 马斯喀特',
    'RUH': '🇸🇦 利雅得', 'JED': '🇸🇦 吉达', 'DMM': '🇸🇦 达曼',
    'CAI': '🇪🇬 开罗', 'HBE': '🇪🇬 亚历山大', 'SSH': '🇪🇬 沙姆沙伊赫',
    'CMN': '🇲🇦 卡萨布兰卡', 'RAK': '🇲🇦 马拉喀什', 'TUN': '🇹🇳 突尼斯', 'ALG': '🇩🇿 阿尔及尔',
    'LOS': '🇳🇬 拉各斯', 'ABV': '🇳🇬 阿布贾', 'ACC': '🇬🇭 阿克拉', 'NBO': '🇰🇪 内罗毕', 'MBA': '🇰🇪 蒙巴萨', 'ADD': '🇪🇹 亚的斯亚贝巴', 'DAR': '🇹🇿 达累斯萨拉姆',
    'JNB': '🇿🇦 约翰内斯堡', 'CPT': '🇿🇦 开普敦', 'DUR': '🇿🇦 德班', 'HRE': '🇿🇼 哈拉雷', 'LUN': '🇿🇲 卢萨卡',
    'MRU': '🇲🇺 毛里求斯', 'SEZ': '🇸🇨 塞舌尔',
    'SYD': '🇦🇺 悉尼', 'MEL': '🇦🇺 墨尔本', 'BNE': '🇦🇺 布里斯班', 'PER': '🇦🇺 珀斯', 'ADL': '🇦🇺 阿德莱德', 'CBR': '🇦🇺 堪培拉', 'OOL': '🇦🇺 黄金海岸', 'CNS': '🇦🇺 凯恩斯',
    'AKL': '🇳🇿 奥克兰', 'WLG': '🇳🇿 惠灵顿', 'CHC': '🇳🇿 基督城', 'ZQN': '🇳🇿 皇后镇',
    'NAN': '🇫🇯 楠迪', 'PPT': '🇵🇫 帕皮提', 'GUM': '🇬🇺 关岛',
    'GRU': '🇧🇷 圣保罗', 'GIG': '🇧🇷 里约热内卢', 'BSB': '🇧🇷 巴西利亚', 'CNF': '🇧🇷 贝洛奥里藏特', 'POA': '🇧🇷 阿雷格里港', 'CWB': '🇧🇷 库里蒂巴', 'FOR': '🇧🇷 福塔莱萨', 'REC': '🇧🇷 累西腓', 'SSA': '🇧🇷 萨尔瓦多',
    'EZE': '🇦🇷 布宜诺斯艾利斯', 'COR': '🇦🇷 科尔多瓦', 'MDZ': '🇦🇷 门多萨',
    'SCL': '🇨🇱 圣地亚哥', 'LIM': '🇵🇪 利马', 'BOG': '🇨🇴 波哥大', 'MDE': '🇨🇴 麦德林',
    'UIO': '🇪🇨 基多', 'GYE': '🇪🇨 瓜亚基尔', 'CCS': '🇻🇪 加拉加斯', 'MVD': '🇺🇾 蒙得维的亚', 'ASU': '🇵🇾 亚松森',
    'PTY': '🇵🇦 巴拿马城', 'SJO': '🇨🇷 圣何塞', 'GUA': '🇬🇹 危地马拉城', 'SAL': '🇸🇻 圣萨尔瓦多',
    'MEX': '🇲🇽 墨西哥城', 'GDL': '🇲🇽 瓜达拉哈拉', 'MTY': '🇲🇽 蒙特雷', 'CUN': '🇲🇽 坎昆',
    'YYZ': '🇨🇦 多伦多', 'YVR': '🇨🇦 温哥华', 'YUL': '🇨🇦 蒙特利尔', 'YYC': '🇨🇦 卡尔加里', 'YEG': '🇨🇦 埃德蒙顿', 'YOW': '🇨🇦 渥太华',
};

const getColoName = (colo: string): string => {
    return (coloMap[colo.toUpperCase()] || colo).trim().replace(/\s+/g, '')|| '未知';
};

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { request, env } = context;
    const url = new URL(request.url);
    // kgcfip 原版 API 使用 ?token=... 鉴权。
    // 为兼容之前可能使用过的旧链接，额外接受 api_token / apitoken / key，
    // 但接口地址、筛选参数和返回文本格式仍保持原版不变。
    const token =
        url.searchParams.get('token') ||
        url.searchParams.get('api_token') ||
        url.searchParams.get('apitoken') ||
        url.searchParams.get('key');

    const sceneParam = url.searchParams.get('scene');
    const latencyParam = url.searchParams.get('latency');
    const regionParam = url.searchParams.get('region');
    const countParam = url.searchParams.get('count');
    // 新增筛选/排序/格式参数（均可选；数值无效时忽略该参数，与原有参数的处理方式一致）
    const minSpeedParam = url.searchParams.get('min_speed');     // 下载速度下限（Mbps）
    const minPurityParam = url.searchParams.get('min_purity');   // 纯净度下限（0-100）
    const maxAgeParam = url.searchParams.get('max_age');         // 数据新鲜度：数字默认为小时，支持 h/d 后缀，如 12h、7d
    const sortParam = (url.searchParams.get('sort') || '').toLowerCase(); // latency(默认) | speed | purity | score
    const formatParam = (url.searchParams.get('format') || '').toLowerCase(); // simple：不追加速度/纯净度字段
    const simpleFormat = formatParam === 'simple' || url.searchParams.get('simple') === '1';

    // 自定义综合评分权重：任意非负数（会自动归一化）；只写其中几项时，未写的按 0 计；都不写则用默认权重
    const wLatency = url.searchParams.get('w_latency');
    const wSpeed = url.searchParams.get('w_speed');
    const wPurity = url.searchParams.get('w_purity');
    const weights: ScoreWeights = (wLatency !== null || wSpeed !== null || wPurity !== null)
        ? normalizeWeights({ latency: Number(wLatency ?? 0), speed: Number(wSpeed ?? 0), purity: Number(wPurity ?? 0) })
        : { ...DEFAULT_SCORE_WEIGHTS };

    // 家宽筛选：home=1 保留“家宽 + 疑似家宽”，home=strict 只保留确认的家宽；需要该 IP 做过纯净度检测
    const homeParam = (url.searchParams.get('home') || '').toLowerCase();
    const homeMode: 'off' | 'any' | 'strict' = homeParam === 'strict' ? 'strict' : (homeParam === '1' || homeParam === 'true') ? 'any' : 'off';

    // 输出家宽标记（默认不输出）：show_home=1 时，家宽 / 疑似家宽的 IP 在延迟后面追加 |家宽 或 |家宽?（疑似家宽）
    const showHome = ['1', 'true'].includes((url.searchParams.get('show_home') || '').toLowerCase());

    const minSpeed = minSpeedParam !== null && minSpeedParam !== '' ? Number(minSpeedParam) : NaN;
    const minPurity = minPurityParam !== null && minPurityParam !== '' ? Number(minPurityParam) : NaN;
    let maxAgeMs = NaN;
    if (maxAgeParam) {
        const m = /^(\d+(?:\.\d+)?)\s*([hd]?)$/i.exec(maxAgeParam.trim());
        if (m) maxAgeMs = Number(m[1]) * (m[2].toLowerCase() === 'd' ? 86400000 : 3600000);
    }

    if (!env.APITOKEN) {
         return new Response('系统错误：未配置 APITOKEN', { status: 500 });
    }

    if (!token || !(await timingSafeEqual(token, env.APITOKEN))) {
        return new Response('TOKEN不合法', { status: 401 });
    }

    try {
        let keys: { name: string }[] = [];
        if (sceneParam) {
            keys = [{ name: `scene:${sceneParam}` }];
        } else {
            const list = await env.IP_KV.list({ prefix: 'scene:' });
            keys = list.keys;
        }
        
        const fetchPromises = keys.map(async (key) => {
            const sceneName = key.name.replace('scene:', '');
            let data = await env.IP_KV.get(key.name, { type: 'json' }) as any[];
            if (!data || !Array.isArray(data)) return [];

            if (latencyParam) {
                const maxLatency = parseInt(latencyParam);
                if (!isNaN(maxLatency)) {
                    data = data.filter(item => item.latency <= maxLatency);
                }
            }

            if (regionParam) {
                const targetRegion = regionParam.toUpperCase();
                data = data.filter(item => item.colo && item.colo.toUpperCase() === targetRegion);
            }

            // 数据格式保护：跳过非对象条目
            data = data.filter(item => item && typeof item === 'object');

            // 下载速度下限：未测速的 IP 视为不满足
            if (Number.isFinite(minSpeed)) {
                data = data.filter(item => Number(item.downloadMbps) >= minSpeed);
            }

            // 纯净度下限：未检测的 IP 视为不满足
            if (Number.isFinite(minPurity)) {
                data = data.filter(item => typeof item.purity?.purityScore === 'number' && item.purity.purityScore >= minPurity);
            }

            // 家宽：没有纯净度数据的 IP 无法判断，视为不满足
            if (homeMode !== 'off') {
                data = data.filter(item => item.purity && isHome(item.purity, homeMode === 'strict'));
            }

            // 数据新鲜度：没有记录测试时间（testedAt）的旧数据视为不满足，重新保存一次即可补上
            if (Number.isFinite(maxAgeMs)) {
                const now = Date.now();
                data = data.filter(item => typeof item.testedAt === 'number' && now - item.testedAt <= maxAgeMs);
            }

            // 给每条数据附上场景名，供后面拼接使用
            return data.map(item => ({ ...item, sceneName }));
        });

        const resultsByScene = await Promise.all(fetchPromises);
        let allItems = resultsByScene.flat();

        // 排序：默认按延迟；sort=speed/purity/score 时按对应指标从高到低，延迟低者优先作为次级排序
        const byLatency = (a: any, b: any) => a.latency - b.latency;
        const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : -1; };
        if (sortParam === 'speed') {
            allItems.sort((a, b) => num(b.downloadMbps) - num(a.downloadMbps) || byLatency(a, b));
        } else if (sortParam === 'purity') {
            allItems.sort((a, b) => num(b.purity?.purityScore) - num(a.purity?.purityScore) || byLatency(a, b));
        } else if (sortParam === 'score') {
            allItems.sort((a, b) => compositeScore(b, weights) - compositeScore(a, weights) || byLatency(a, b));
        } else {
            allItems.sort(byLatency);
        }

        // 如果传了 count 参数，只取前 N 条
        if (countParam) {
            const count = parseInt(countParam);
            if (!isNaN(count) && count > 0) {
                allItems = allItems.slice(0, count);
            }
        }
        
        const formattedResults = allItems.map(item => {
            const region = item.colo ? getColoName(item.colo) : '未知';
            const alias = `${region}|${item.sceneName}`;
            let line = `${item.ip}:${item.port}#${alias}|${item.latency}ms`;

            // 家宽标记（可选）：只有做过纯净度检测、且判为家宽 / 疑似家宽的才输出，紧跟在延迟之后
            if (showHome && item.purity) {
                const home = classifyHome(item.purity);
                if (home === 'residential') line += '|家宽';
                else if (home === 'likely') line += '|家宽?';
            }

            if (simpleFormat) return line;

            const speed = Number(item.downloadMbps);
            if (Number.isFinite(speed) && speed > 0) {
                line += `|${speed.toFixed(2)}Mbps`;
            }

            const purityScore = item.purity?.purityScore;
            if (typeof purityScore === 'number' && Number.isFinite(purityScore) && purityScore >= 0 && purityScore <= 100) {
                line += `|${purityScore}/100`;
            }

            return line;
        });
        return new Response(formattedResults.join('\n'), {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            }
        });

    } catch (err) {
        return new Response((err as Error).message, { status: 500 });
    }
};
