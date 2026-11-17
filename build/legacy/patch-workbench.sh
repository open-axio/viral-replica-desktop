#!/bin/bash
# 给 workbench 前端打补丁：把 Electron 不支持的同步 prompt() 换成页面内自定义输入弹窗。
# 用法: bash patch-workbench.sh <workbench目录>
# 可重复运行（幂等：检测到已打补丁会跳过）。
set -euo pipefail
WB="${1:?用法: bash patch-workbench.sh <workbench目录>}"
APP="$WB/web/app.js"
[ -f "$APP" ] || { echo "找不到 $APP"; exit 1; }

if grep -q 'function pagePrompt(' "$APP"; then
  echo "app.js 已打过补丁，跳过"
  exit 0
fi

python3 - "$APP" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

NEW_FUNCS = '''let pagePromptState=null;
function pagePrompt(message, defaultValue='', title='请输入'){
  if(pagePromptState)finishPagePrompt(null);
  const box=$('#pageConfirmation'),pid=P?.id,previous=document.activeElement;
  const def=String(defaultValue??'');
  updateHtml(box,`<section class="page-confirmation-card"><h3 id="pageConfirmationTitle">${esc(title)}</h3><p>${esc(message)}</p><input id="pagePromptInput" type="text" value="${esc(def)}" style="width:100%;box-sizing:border-box;padding:9px 10px;margin:10px 0;font-size:14px;border:1px solid #ccc;border-radius:6px"><div class="row end"><button class="ghost" id="pagePromptCancel">取消</button><button class="pay" id="pagePromptOk">确定</button></div></section>`);
  box.hidden=false;if($('#app'))$('#app').inert=true;
  return new Promise(resolve=>{
    pagePromptState={resolve,pid,previous};
    const input=$('#pagePromptInput',box),ok=$('#pagePromptOk',box),cancel=$('#pagePromptCancel',box);
    const finish=(val)=>{
      if(!pagePromptState)return;
      ok.removeEventListener('click',onOk);cancel.removeEventListener('click',onCancel);input.removeEventListener('keydown',onKey);
      finishPagePrompt(val);
    };
    const onOk=()=>finish(input.value);
    const onCancel=()=>finish(null);
    const onKey=(e)=>{if(e.key==='Enter'){e.preventDefault();finish(input.value);}else if(e.key==='Escape'){e.preventDefault();finish(null);}};
    ok.addEventListener('click',onOk);cancel.addEventListener('click',onCancel);input.addEventListener('keydown',onKey);
    setTimeout(()=>{try{input.focus();input.select();}catch(_){}},0);
  });
}
function finishPagePrompt(value){
  const pending=pagePromptState;if(!pending)return;
  pagePromptState=null;$('#pageConfirmation').hidden=true;if($('#app'))$('#app').inert=false;
  if(pending.previous?.isConnected)pending.previous.focus({preventScroll:true});
  pending.resolve(value);
}
'''

anchor = 'function comparisonNeedsBoard(s){'
assert anchor in s, '找不到插入锚点 comparisonNeedsBoard'
s = s.replace(anchor, NEW_FUNCS + anchor, 1)

kd = "  if(pageConfirmation){\n    if(e.key==='Escape'){e.preventDefault();finishPageConfirmation(false);}"
assert kd in s, '找不到 keydown 锚点'
s = s.replace(kd, "  if(pagePromptState){\n    if(e.key==='Escape'){e.preventDefault();finishPagePrompt(null);}\n    return;\n  }\n" + kd, 1)

repl = [
    ('const name = prompt("项目名称", "复刻 " + new Date().toLocaleDateString());',
     'const name = await pagePrompt("项目名称", "复刻 " + new Date().toLocaleDateString());'),
    ("const remote=prompt('填写这次生成的远端任务 ID');",
     "const remote=await pagePrompt('填写这次生成的远端任务 ID');"),
    ('const id = prompt("填写三方渠道后台里这次任务的远端 task_id（不会重新创建付费任务）");',
     'const id = await pagePrompt("填写三方渠道后台里这次任务的远端 task_id（不会重新创建付费任务）");'),
]
for old, new in repl:
    assert old in s, f'找不到 prompt 调用: {old[:30]}'
    s = s.replace(old, new, 1)

open(p, 'w', encoding='utf-8').write(s)
print('已给 app.js 打补丁')
PY

node --check "$APP" >/dev/null 2>&1 && echo "app.js 语法检查通过" || { echo "语法检查失败"; exit 1; }
