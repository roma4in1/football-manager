import cv2, numpy as np, json, glob, sys
exec(open('track4.py').read().split("def detect(")[0])

def detect(img, H):
    warp = cv2.warpPerspective(img, H, (1050, 680))
    hsv = cv2.cvtColor(warp, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    V = hsv[..., 2]
    bg = cv2.medianBlur(V, 61)
    delta = cv2.subtract(V, bg)
    mask = cv2.inRange(delta, 22, 255)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, cent = cv2.connectedComponentsWithStats(mask, 8)
    out = []
    SPOTS = [(11.0, 34.0), (94.0, 34.0), (52.5, 34.0)]
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        w0, h0 = stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]
        if not (60 <= area <= 5200) or h0 > 70 or w0 > 110: continue
        sel = lab == i
        hh = int(np.median(h[sel])); ss = int(np.median(s[sel])); vv = int(np.median(v[sel]))
        xm, ym = cent[i][0] / 10.0, cent[i][1] / 10.0
        if not (0.5 < xm < 104.5 and 0.5 < ym < 67.5): continue
        if area < 140:
            if any(abs(xm - sx) < 1.6 and abs(ym - sy) < 1.6 for sx, sy in SPOTS): continue
            if vv > 150: out.append(('ball', round(xm, 2), round(ym, 2), int(area)))
            continue
        if ss > 85 and 20 < hh < 40: cls = 'yellow'
        elif ss > 40 and (hh < 16 or hh > 150): cls = 'pink'
        elif ss >= 45 and 30 <= hh <= 100: cls = 'green'
        elif ss < 45 and vv > 150: cls = 'white'
        else: continue
        k = 1 if cls in ('yellow', 'pink') else min(6, max(1, round(area / 430)))
        if k == 1:
            out.append((cls, round(xm, 2), round(ym, 2), int(area)))
        else:
            pts = np.column_stack(np.nonzero(sel)).astype(np.float32)  # (y,x)
            _, _, centers = cv2.kmeans(pts, k, None,
                (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0), 3, cv2.KMEANS_PP_CENTERS)
            for cy, cx in centers:
                out.append((cls, round(cx / 10.0, 2), round(cy / 10.0, 2), int(area // k)))
    return out

def run(clip, folder=None, out=None):
    folder = folder or f'fr{clip}'
    out = out or f'tr{clip}.json'
    frames = []
    total = len(glob.glob(f'{folder}/f*.png'))
    for f in sorted(glob.glob(f'{folder}/f*.png')):
        img = cv2.imread(f)
        H, sc = pick_H(img, CANDS[clip])
        if sc < 200000: continue
        H2 = refine(img, H)
        if H2 is None: continue
        dots = detect(img, H2)
        gw = [d for d in dots if d[0] == 'white']; gg = [d for d in dots if d[0] == 'green']
        if not (7 <= len(gw) <= 12 and 7 <= len(gg) <= 12): continue
        frames.append({'f': f.split('/')[-1], 'dots': dots})
    json.dump(frames, open(out, 'w'))
    print(clip, folder, '->', len(frames), 'usable /', total)

if __name__ == '__main__':
    if len(sys.argv) > 1:
        run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None, sys.argv[3] if len(sys.argv) > 3 else None)
    else:
        for c in ['7245', '7244', '7243']: run(c)
