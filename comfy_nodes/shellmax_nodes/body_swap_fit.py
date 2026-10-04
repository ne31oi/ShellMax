"""Track source head geometry and transfer only broad scene illumination."""
import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d


def face_track(images, detector_path, check=lambda: None):
    height, width = images.shape[1:3]
    detector = cv2.FaceDetectorYN.create(str(detector_path), "", (width, height), 0.45)
    boxes = np.full((len(images), 4), np.nan, dtype=np.float32)
    for i, image in enumerate(images):
        check()
        bgr = cv2.cvtColor((image.clip(0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR)
        _, found = detector.detect(bgr)
        if found is not None:
            boxes[i] = max(found, key=lambda face: face[2] * face[3])[:4]
    valid = np.isfinite(boxes[:, 0])
    if not valid.any():
        raise ValueError("Не найдено лицо для привязки размера головы к исходнику")
    for channel in range(4):
        boxes[:, channel] = np.interp(np.arange(len(images)), np.flatnonzero(valid), boxes[valid, channel])
    return gaussian_filter1d(boxes, 1.2, axis=0, mode="nearest")


def head_weight(shape, face):
    height, width = shape
    x, y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    center = face[:2] + face[2:] / 2
    dx = np.maximum(0, np.abs(x-center[0]) - face[2]*0.7) / (face[2]*0.65)
    dy = np.maximum(0, y-(face[1]+face[3]*1.04)) / (face[3]*0.6)
    weight = np.clip(1-np.maximum(dx,dy),0,1)
    weight = weight*weight*(3-2*weight)
    return weight


def head_maps(shape, source_face, donor_face):
    """Uniform scale inside the head; smoothly pin the surrounding torso and arm."""
    height, width = shape
    x, y = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    sc = source_face[:2] + source_face[2:] / 2
    dc = donor_face[:2] + donor_face[2:] / 2
    scale = float(np.clip(source_face[3] / donor_face[3], 0.65, 1.5))
    weight = head_weight(shape,source_face)
    # Keep the contacting forearm at the frame boundary instead of pulling
    # transparent padding into a limb which continues outside the image.
    border = np.clip(y/64,0,1)
    weight *= border*border*(3-2*border)
    map_x = x + weight*((x-sc[0])/scale+dc[0]-x)
    map_y = y + weight*((y-sc[1])/scale+dc[1]-y)
    return map_x.astype(np.float32), map_y.astype(np.float32), scale


def align_head(source, donor, alpha, detector_path, check=lambda: None):
    source_faces = face_track(source, detector_path,check)
    donor_faces = face_track(donor, detector_path,check)
    images, mattes, scales = [], [], []
    for image, matte, original_face, replacement_face in zip(donor, alpha, source_faces, donor_faces):
        check()
        mx, my, scale = head_maps(matte.shape, original_face, replacement_face)
        images.append(cv2.remap(image, mx, my, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101))
        mattes.append(cv2.remap(matte, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT))
        scales.append(scale)
    return np.stack(images).clip(0,1), np.stack(mattes).clip(0,1), source_faces, np.asarray(scales)


def scene_relight(source, donor, faces, old_alpha, new_alpha):
    """Use broad RGB gain, not source face texture or source costume colors."""
    gains = []
    for original, replacement, (x,y,w,h) in zip(source, donor, faces):
        x0,x1 = int(x+w*0.18),int(x+w*0.82)
        bands=[]
        # Forehead, cheeks and jaw infer broad light direction. Exclude the eyes
        # and mouth so expression or eye color cannot drive the exposure curve.
        for lo,hi in ((0.18,0.32),(0.48,0.64),(0.80,0.94)):
            y0,y1=int(y+h*lo),int(y+h*hi)
            a,b = original[y0:y1,x0:x1], replacement[y0:y1,x0:x1]
            bands.append(np.clip((np.median(a,axis=(0,1))+0.01)/(np.median(b,axis=(0,1))+0.01),0.2,1.6))
        gains.append(bands)
    gains = gaussian_filter1d(np.stack(gains), 2, axis=0, mode="nearest")
    output=[]
    for original,replacement,face,bands,old,new in zip(source,donor,faces,gains,old_alpha,new_alpha):
        weight=head_weight(old.shape,face)
        old_body=(old>0.99)&(weight<0.15)
        new_body=(new>0.99)&(weight<0.15)
        # Costume color stays intact. Match broad highlight exposure separately
        # from the face, whose shadow is much deeper than the overhead-lit arm.
        luma=lambda image:image@np.array([0.2126,0.7152,0.0722],np.float32)
        exposure=1.0
        if old_body.any() and new_body.any():
            exposure=float(np.clip((np.quantile(luma(original)[old_body],0.95)+0.01)/
                                   (np.quantile(luma(replacement)[new_body],0.95)+0.01),0.6,1.2))
        gain=bands[1]
        chroma=gain/(float(gain@np.array([0.2126,0.7152,0.0722]))+1e-6)
        anchors=face[1]+face[3]*np.array([0.25,0.56,0.87])
        profile=np.stack([np.interp(np.arange(len(old)),anchors,bands[:,c]) for c in range(3)],axis=1)
        field=weight[:,:,None]*profile[:,None,:]+(1-weight[:,:,None])*chroma*exposure
        output.append((replacement*field).clip(0,1))
    return np.stack(output), gains


def vacancy_masks(old_alpha, new_alpha, margin=4):
    """Restore the vacated old person, while retaining existing visible background."""
    kernel = np.ones((2*margin+1,2*margin+1),np.uint8)
    old = np.stack([cv2.dilate((frame>0.02).astype(np.uint8),kernel) for frame in old_alpha])
    opaque = np.stack([cv2.erode((frame>0.995).astype(np.uint8),np.ones((3,3),np.uint8)) for frame in new_alpha])
    return (old*(1-opaque)).astype(np.float32)


def local_background(source, old_alpha, new_alpha, radius=5, margin=4, check=lambda: None, progress=lambda: None):
    """Extend existing scene colors into vacancies; preserve all other background pixels."""
    vacancy=vacancy_masks(old_alpha,new_alpha,margin)
    kernel=np.ones((2*margin+1,2*margin+1),np.uint8)
    plate=[]
    for original,old,hole in zip(source,old_alpha,vacancy):
        check()
        mask=cv2.dilate((old>0.02).astype(np.uint8),kernel)
        # Erase the original person as context, but retain only the newly exposed
        # pixels of this paint. Large hidden areas cannot overwrite visible walls.
        painted=cv2.inpaint((original.clip(0,1)*255).astype(np.uint8),mask,radius,cv2.INPAINT_TELEA).astype(np.float32)/255
        plate.append(np.where(hole[:,:,None]>0,painted,original))
        progress()
    return np.stack(plate)
