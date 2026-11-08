"""Apply the reviewed browser workflow to idle Codex employees with revision guards."""
import argparse
import hashlib
import json
import urllib.request
from urllib.parse import urlencode

parser = argparse.ArgumentParser()
parser.add_argument('--company-id', required=True)
parser.add_argument('--apply', action='store_true')
parser.add_argument('--project-root')
args = parser.parse_args()
base = 'http://127.0.0.1:3100/api'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
marker = '<!-- PAPERCLIP_PROJECT_BROWSER_V2 -->'
end = '<!-- /PAPERCLIP_PROJECT_BROWSER_V2 -->'
common = '''## 产品交付执行流程 v2

### 开工澄清与资源确认

先识别当前任务属于真实产品需求、已有产品修改，还是公司流程/平台改造。流程与平台改造的验收使用预设的合成场景和测试夹具；测试中的产品名称、功能偏好与目录由测试方案确定，不能把这些测试细节作为用户的新产品需求，也不能向用户发测试项目的产品问答。只有真实需求中影响目标、资源或权限且未获授权的信息才由CEO提问。用户明确要求新建试点产品并参与其需求确认时，才进入该试点的真实产品问答。

CEO 收到新项目需求后，先读取本任务已有需求、回答和公司授权，组织一轮相关岗位的需求评审。用带负责人的短咨询子任务异步开会，每位最多提交5项“缺口、影响、推荐方案、是否需要用户决定”；小项目只邀请真正相关岗位，避免轮流闲聊和重复建单。PM汇总用户和核心功能、优先级；设计汇总风格、交互和素材；CTO与RE核对代码库位置、现有代码保留、技术环境、账号与API、数据与资源、费用和权限；QA把验收标准、设备和数据风险前置。CEO负责去重、解决内部技术选型，并形成一份启动记录。

CEO通过原任务的request_human_input发起真实问答卡，interactionKind=questions、resolverPolicy=human_only、continuationPolicy=wake_assignee。payload包含version=1和完整questionSet，schema=paperclip.question_set.v1。每轮只问当前影响结果的少量问题，相关问题合并，提供推荐选项和取舍；开放问题用answerMode=text，选择题至少两个有效选项并允许自填。已有明确回答不重问，不让用户替团队作普通技术选择。保存成功后记录interactionId和可点击链接，保持CEO为负责人，以in_review等待；回答由平台恢复CEO，不能只在评论里提问然后停工。只有影响需求、资源或授权的新增事实才开启下一轮。

代码位置须确认新建或复用、绝对路径、当前项目工作区绑定以及现有文件保留范围；已授权公司目录可提出默认子目录供用户确认，用户说由团队决定即采用并记录。资源清单逐项记录用途、来源、权限和验收方式，缺API KEY先确认服务、接口、额度与授权。密钥、令牌和私密数据使用Paperclip Secrets、连接或受控资源入口，问答卡只收集配置偏好和资源引用，禁止让用户把密钥粘到任务、文档或代码。澄清回答不代替费用、权限、外部发布或真实数据处理的正式审批；确需审批时团队先生成具体审批卡。

启动记录至少包含目标用户与问题、核心任务、范围及不做项、产品偏好、验收矩阵、仓库与分支、工作区、执行能力、资源引用、费用与授权边界、负责人及未决问题。每项标明用户已确认、用户授权团队决定、或待回答。CEO在影响开发方向的问题、必要资源和授权确认后发布“可开工”结论，才派实现任务。等待答复期间仅继续不依赖答案且已授权的资料核查、预检或方案准备。资源缺口由对应岗位提供准确的获取入口，避免开工后才第一次索要。需求变化只复核受影响部分。

### 实现、验收与恢复

开工时检查工具清单。浏览器项目由 CTO 或 RE 在实际任务运行中调用 project_browser(action=preflight)，验证宿主建页、点击和截图。UI 实现前，PM 与设计冻结核心用户任务、需要的视口、空态和错误恢复、独立功能与体验验收人。缺少此工具时由 CTO 检查公司的宿主配置与运行是否已加载新版，不承诺已经具备浏览器验收能力。

静态产品交固定提交后，独立验收人直接使用 project_browser(action=open, commit=完整40位SHA)，有提交过的构建输出时指定 publishDir。这个入口自行提供隔离页面，动态分配端口，无需等待人工启动 server.cjs。先观察返回的页面树和图片，再决定点击、输入、键盘和视口操作。默认会话为390×844，可按矩阵改为320、430或其他宽度。只在当前公司授权根目录和当前任务工作区操作，不请求扩大 Runner 权限。后端、外部服务、真实模型、真机等额外环境由 CTO 在开发前确认适用授权与可用入口。

查看既有截图时先 list_task_attachments，再用 read_task_image(attachmentId, expectedSha256) 读取 PNG 原件。图片通过视觉输入返回。Codex Code Mode 中工具可能返回 JSON 字符串，须用 const r = await tools.read_task_image(args); const v = typeof r === "string" ? JSON.parse(r) : r; image(v.image_url); 展示图片。project_browser 同样处理，输出状态时仅打印 v.state 等元数据，不打印 image_url 或编码内容。不能把哈希或文字树当作实际看图。当前工具只支持300KB以内PNG，超限时由 RE 提供适配的独立查看副本并保留原件、哈希和转换来源。其他任务的附件由原负责人通过正常附件权限交接，不搬宿主路径。截图或矩阵已有结果时复用，不重跑获取证据。

project_browser 按当前运行隔离，会话最多十分钟。下一运行重新打开固定版本，并说明新会话状态；同一调用重试先复用回执，结果不明先 observe，不盲目重复点击。每个验收结论记录版本、实际观察、使用视口、未验证范围及截图来源。模拟手机与实机分别列明；只有项目范围要求实机时，实机才是交付门槛。

环境失败后保存首条错误，先复用工具返回的唯一恢复任务。遇到当前可写根不覆盖已授权资源时，CTO先用list_workspaces查现有工作区，通过select_workspace或正常工作区管理API选择确实覆盖该资源的既有授权工作区，并在新入场用get_workspace确认实际绑定与可写根；保持原修复人、项目和验收依赖。路径能读、任务描述有授权、配置已写都不能代替实际执行权限。不存在合适的已授权工作区时才提交具体的受管执行或权限申请。需要新建修复任务时，用当前任务引用向 CTO 分派唯一修复任务，写清恢复动作和原验收人；使用任务依赖或 monitor 等待具体事件。CTO 修复后在原任务回传可核验证据并恢复原负责人。其他可执行工作继续。CEO 只向董事会提交有可点击审批卡的权限变更或业务取舍。同条件失败不循环重试，无新证据不轮流唤醒。功能和体验分别独立签署，CEO 核齐后收口。
'''
if args.project_root:
    common += '\n新项目工作区在已授权公司专属目录下创建：' + args.project_root + '/<项目名>。当前任务工作区仍以 Paperclip 绑定为准；新项目不要沿用其他项目路径。\n'
roles = {
    'CTO': '本岗位在开工评审中确认代码库位置、数据/API/密钥来源、预算和授权缺口，将必要的业务取舍交CEO汇总。本岗位负责开工环境预检和技术恢复。遇到可写根不匹配先核查并选择既有授权工作区，验证实际生效，再执行被授权的修复；不要把普通工作区选择问题直接转为董事会排障。创建受管执行登记时指定 recoveryAgentId 为本岗位，确保预检失败、缺原件或接续失败自动形成有负责人的修复任务。修复后负责原验收任务恢复，不能只回复“需平台处理”。',
    'Release Engineer': '本岗位在交接前验证验收人可以使用 project_browser 和 read_task_image，交固定版本、可读原件和哈希。预览端口由受管入口分配，不要求用户运行固定端口命令。',
    'QA Engineer': '本岗位自行读取原始图片和操作页面，按已有矩阵核验；区分本人实际视觉观察、自动断言和他人收据，未观察的状态不签通过。',
    'Product & Project Manager': '本岗位在开工评审中汇总功能边界、用户偏好和验收问题，由CEO统一向用户澄清。本岗位拥有体验签核责任。用受管浏览器独立完成核心用户任务，记录引导需求、误操作和恢复。验收前直接获取操作能力，入口HTTP200不足以证明可以体验签核。',
    'UI/UX Designer': '本岗位用实际页面的图片与交互核对设计，覆盖正常、空态、错误反馈和窄屏；在实现前明确用户需要看到的信息与体验验收门槛。',
    'CEO': '本岗位主持开工需求评审并统一向用户提问，维护回答到启动记录的对应关系。确认需求、资源、工作区和必要授权后发布可开工结论，分派开发并对原验收人的实际接续负责，追踪具体修复任务与依赖解除。不得以有审批、有HTTP200、有哈希替代可用执行、可操作页面和已查看图片。',
}

def api(path, data=None):
    request = urllib.request.Request(base + path, None if data is None else json.dumps(data).encode(), {'Content-Type': 'application/json'}, method='GET' if data is None else 'PUT')
    with opener.open(request, timeout=15) as response:
        return json.load(response)

plans = []
for agent in api('/companies/' + args.company_id + '/agents'):
    if agent['adapterType'] != 'paperclip_runner' or agent['adapterConfig'].get('provider') != 'codex':
        continue
    if agent['status'] not in ('idle', 'paused'):
        raise RuntimeError('Employee must settle before instruction update: ' + agent['name'])
    assert agent['companyId'] == args.company_id
    root = '/agents/' + agent['id'] + '/instructions-bundle/file'
    entry = agent['adapterConfig'].get('instructionsEntryFile') or 'AGENTS.md'
    read = root + '?' + urlencode({'path': entry})
    old = api(read)
    content = old['content']
    section = marker + '\n' + common + '\n' + roles.get(agent['name'], '本岗位在职责范围使用上述交接标准，保留原有专业职责。') + '\n' + end
    if marker in content:
        start = content.index(marker)
        stop = content.index(end, start) + len(end)
        updated = content[:start] + section + content[stop:]
    else:
        updated = content.rstrip() + '\n\n' + section + '\n'
    if updated == content:
        print(agent['name'], 'current')
        continue
    revision = (old.get('revision') or {}).get('id')
    guard = {'baseRevisionId': revision} if revision else {'baseHash': hashlib.sha256(content.encode()).hexdigest()}
    plans.append((agent['name'], root, read, {'path': entry, 'content': updated, **guard}))
for name, root, read, payload in plans:
    if args.apply:
        result = api(root, payload)
        assert api(read)['content'] == payload['content']
        print(name, 'applied', (result.get('revision') or {}).get('id'))
    else:
        print(name, 'ready')
