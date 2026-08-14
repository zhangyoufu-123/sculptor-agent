#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同主题风格判别红队盲评（v1.0，Python/urllib 版，规避 Node undici 对推理模型长请求的读超时）。
剥离内容信号：四篇同为"北大红楼"主题的文本两两配对（C(4,2)=6 对），由 DeepSeek 以
"完全盲人"文学编辑身份判断"两段是否出自同一作者"，并给出可量化笔法理由；随机基线 50%。
同作者对照组：让模型模仿目标作者笔法写一篇同主题新文，再判断"原文 × 新文"是否同一作者。
用法：python3 scripts/experiments/redteam-same-topic-style.py [--out result.json]
"""
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_env():
    f = os.path.join(ROOT, '.env.local')
    if not os.path.exists(f):
        return
    for line in open(f, encoding='utf-8'):
        m = re.match(r'^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$', line)
        if m and m.group(1) not in os.environ:
            os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


def llm(messages, max_tokens=2000, temperature=0.0, json_mode=True, timeout=180):
    load_env()
    url = os.environ.get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/').rstrip('/') + '/chat/completions'
    key = os.environ['DEEPSEEK_API_KEY']
    model = os.environ.get('DEEPSEEK_MODEL', 'deepseek-v4-flash')
    body = {'model': model, 'messages': messages, 'max_tokens': max_tokens, 'temperature': temperature}
    if json_mode:
        body['response_format'] = {'type': 'json_object'}
    data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def content_of(resp):
    msg = resp.get('choices', [{}])[0].get('message', {})
    c = msg.get('content', '')
    if not c or not str(c).strip():
        c = msg.get('reasoning_content', '')
    return str(c).strip()


TEXTS = {
    '目标作者': (
        '那年秋天，我第二次走进北大红楼。石阶还是旧的，被一百年的脚步磨出了光泽。'
        '窗台上积着灰，我伸手一抹，指腹上留下一道深色的痕。红砖墙在暮色里发暗，'
        '我想起课本里那句"破晓的号角"，忽然明白历史不是摆在玻璃柜里的展品，'
        '它一直等着一个人走进去。风从门里出来，带着木头的气味。我在门口站了很久，'
        '久到门卫多看了我两眼。后来我常想，历史并不只在年份里，也在门槛被磨低的弧度里，'
        '在每一个路过的人停下来看的那一眼里。'
    ),
    '样本1': (
        '门开着。石阶旧，被磨得发亮。我在门口站了一会儿，没有进去。风从里面出来，'
        '带着木头的气味。我想，一百年前有人也这样站过。历史不响，它只是等着。'
        '木梯窄，每一步都响。窗台积灰，灰上有细痕，像谁用手指划过。我没有擦，只是看。'
        '过去不说话，可它留了痕迹。回头，楼还在。暮色里，红砖暗下去。'
        '纪念牌上的字，我念了一遍。历史从不等谁，它只等人走进去，再走出来。'
    ),
    '样本2': (
        '你猜怎么着，我今儿站北大红楼门口，腿都有点软。那石阶，磨得能当镜子照，'
        '一百年多少人踩过啊。门是深红的，漆都掉了，露出底下的灰白，特像我家那老木柜。'
        '我寻思，一百年前那个早晨，是不是也有个学生娃，攥着纸，手心出汗，站这儿愣神。'
        '上楼那木梯，嘎吱嘎吱响，跟要散架似的。二楼那窗户，窗台上全是灰，'
        '灰上还有几道印子，跟人拿指甲划的。我趴在窗边往外瞅，树影被玻璃压得扁扁的。'
    ),
    '样本3': (
        '风从门里涌出，像一声古老的叹息。石阶被一百年的脚步磨得发亮，我踏上它，'
        '仿佛踏在雷声与号角的交界。门扉深红，漆皮剥落处露出苍白的底色，'
        '那是时间亲手留下的年轮。我想象那个早晨：长衫的青年攥着传单，掌心滚烫，'
        '他跨过门槛的瞬间，历史便从纸面站起，成为人。木梯向上，每一步都像擂鼓，'
        '在空旷的穹顶下回荡。人们说历史很远，可它就在这灰里、这木纹里，'
        '等着一个敢走进去的人，把它重新点燃。'
    ),
}

JUDGE_SYS = (
    '你是一位资深文学编辑，正在做完全盲评的写作判别实验。你只看到两段文字，不知道作者是谁。'
    '请只依据笔法判断：两段是否出自同一作者。笔法指句长、短句比例、口语化程度、意象密度、用词与节奏；'
    '不要依据内容主题（两段可能主题相同）。直接输出 JSON，禁止输出思考过程或重复题目。'
    'JSON 格式：{"same":布尔,"confidence":0到1,"reason":"用可量化笔法差异说明，如\\"甲句长均值约30字、乙约11字\\""}'
)


def judge(a_label, b_label, ta, tb):
    for _ in range(3):
        try:
            resp = llm(
                [
                    {'role': 'system', 'content': JUDGE_SYS},
                    {'role': 'user', 'content': f'甲：\n{ta}\n\n乙：\n{tb}'},
                ],
            )
            c = content_of(resp)
            m = re.search(r'\{[\s\S]*\}', c)
            obj = json.loads(m.group(0) if m else c)
            if isinstance(obj.get('same'), bool):
                return obj
        except Exception:  # noqa: BLE001
            time.sleep(2)
    return {'same': None, 'confidence': None, 'reason': '多次尝试未得到有效 JSON 结论'}


def generate_same_author_control():
    prompt = (
        '请模仿下面这段文字的笔法（句长、短句比例、意象密度、用词节奏），'
        '写一段新的、主题仍为"北大红楼"的文字，约 150 字，不要重复示例里的句子。只输出正文。'
        f'\n\n示例：\n{TEXTS["目标作者"]}'
    )
    try:
        resp = llm([{'role': 'user', 'content': prompt}], max_tokens=1500, temperature=0.85, json_mode=False)
        return content_of(resp)
    except Exception:  # noqa: BLE001
        return ''


def main():
    names = list(TEXTS)
    disc = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            jdg = judge(names[i], names[j], TEXTS[names[i]], TEXTS[names[j]])
            correct = jdg['same'] is False
            disc.append({'a': names[i], 'b': names[j], 'expected': 'different', 'judgedSame': jdg['same'],
                         'correct': correct, 'judge': jdg})
            print(f"\n[判别] {names[i]} × {names[j]} → same={jdg['same']} (期望 different) 正确={correct}")
            print(f"  {jdg['reason']}")
            sys.stdout.flush()

    ctrl_text = generate_same_author_control()
    ctrl = judge('目标作者', '目标作者(模仿续写)', TEXTS['目标作者'], ctrl_text)
    ctrl_correct = ctrl['same'] is True
    print(f"\n[同作者对照] 原文 × 模仿续写 → same={ctrl['same']} (期望 same) 正确={ctrl_correct}")
    print(f"  续写：{(ctrl_text or '')[:90]}…")
    print(f"  {ctrl['reason']}")

    n = len(disc)
    ok = sum(1 for d in disc if d['correct'])
    acc = ok / max(1, n)
    summary = {
        'task': '同主题风格判别盲评（剥离内容信号）',
        'discrimination': {'pairs': n, 'correct': ok, 'accuracy': acc, 'chance': 0.5},
        'sameAuthorControl': {'judgedSame': ctrl['same'], 'correct': ctrl_correct, 'text': ctrl_text},
        'note': 'LLM 模拟人类审阅者、完全盲评；与生成同用 DeepSeek，属内部开发指标，未经真人验证，不可作为有效性证据。',
        'details': disc + [{'a': '目标作者', 'b': '目标作者(模仿续写)', 'expected': 'same',
                            'judgedSame': ctrl['same'], 'correct': ctrl_correct, 'judge': ctrl, 'text': ctrl_text}],
    }
    out = os.path.join(ROOT, 'docs', 'competition', 'redteam-same-topic-style.json')
    if '--out' in sys.argv:
        out = sys.argv[sys.argv.index('--out') + 1]
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f"\n判别准确率：{ok}/{n} = {acc*100:.0f}%（随机基线 50%）")
    print(f"同作者对照：{'判为同一作者（风格保真）' if ctrl_correct else '判为不同作者'}")
    print(f"结果已写入 → {out}")


if __name__ == '__main__':
    main()
