"""Selection geometry, independent of ComfyUI and detector/model imports."""


def select_face(boxes, region):
    x, y, w, h = region
    inside = []
    for face in boxes:
        x0, y0, x1, y1 = map(float, face)
        area = max(0, min(x + w, x1) - max(x, x0)) * max(0, min(y + h, y1) - max(y, y0))
        if x <= (x0 + x1) / 2 <= x + w and y <= (y0 + y1) / 2 <= y + h and area >= (x1 - x0) * (y1 - y0) * 0.6:
            inside.append((x0, y0, x1, y1))
    if not inside:
        raise ValueError("В выбранной рамке не найдено лицо — выберите кадр с видимым лицом и обведите всю голову")
    if len(inside) != 1:
        raise ValueError("В рамке несколько лиц — обведите голову только одного человека")
    return inside[0]


def head_region(region, face):
    """User's complete head relative to the detected face, so it follows that face over time."""
    x, y, w, h = region
    fx, fy, x1, y1 = face
    fw, fh = x1 - fx, y1 - fy
    return (x - fx) / fw, (y - fy) / fh, w / fw, h / fh


def region_in_canvas(relative, face_rect):
    x, y, w, h = relative
    fx, fy, fw, fh = face_rect
    return fx + x * fw, fy + y * fh, w * fw, h * fh


def required_crop_factor(region, face, minimum):
    x, y, w, h = region
    x0, y0, x1, y1 = face
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    factor = 2 * max(abs(x - cx), abs(x + w - cx), abs(y - cy), abs(y + h - cy)) / (y1 - y0) * 1.1
    if factor > 8:
        raise ValueError("Рамка слишком широкая — выделите только голову, без тела и других людей")
    return max(minimum, factor)
