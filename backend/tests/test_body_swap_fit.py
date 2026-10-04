"""Geometric registration preserves the torso; background repair never repaints visible scenery."""
import importlib.util
from pathlib import Path

import numpy as np
import pytest

spec=importlib.util.spec_from_file_location("body_swap_fit",Path(__file__).resolve().parents[2]/"comfy_nodes/shellmax_nodes/body_swap_fit.py")
fit=importlib.util.module_from_spec(spec)
spec.loader.exec_module(fit)


def test_head_center_scale_and_frame_boundary_are_registered():
    source=np.array([80,80,80,100],np.float32)
    donor=np.array([70,90,100,125],np.float32)
    mx,my,scale=fit.head_maps((300,300),source,donor)
    assert scale==pytest.approx(.8)
    assert mx[130,120]==pytest.approx(120)
    assert my[130,120]==pytest.approx(152.5)
    assert my[110,120]-my[130,120]==pytest.approx(-25)
    # The lower torso and cropped-off hand keep their original coordinates.
    assert mx[290,120]==120 and my[290,120]==290
    assert my[0,120]==0
    assert np.gradient(mx,axis=1).min()>0
    assert np.gradient(my,axis=0).min()>0


def test_vacancy_removes_old_hair_but_does_not_delete_opaque_new_person():
    old=np.zeros((2,60,60),np.float32)
    old[:,10:50,10:50]=1
    new=np.zeros_like(old)
    new[:,15:45,20:45]=1
    holes=fit.vacancy_masks(old,new,margin=2)
    assert holes[:,25,15].all()
    assert not holes[:,25,30].any()
    assert not holes[:,0,0].any()


def test_local_background_preserves_known_pixels_and_cancellation():
    original=np.ones((2,64,64,3),np.float32)*np.array([.1,.5,.6],np.float32)
    old=np.zeros((2,64,64),np.float32)
    old[:,15:49,15:49]=1
    original[:,15:49,15:49]=[.7,.1,.1]
    new=np.zeros_like(old)
    new[:,20:44,20:44]=1
    plate=fit.local_background(original,old,new,margin=2)
    np.testing.assert_array_equal(plate[:,:10],original[:,:10])
    np.testing.assert_array_equal(plate[:,30,30],original[:,30,30])
    assert (plate[:,30,16,1]>.3).all()
    calls=[]
    def cancel():
        calls.append(1)
        raise RuntimeError("Cancelled")
    with pytest.raises(RuntimeError,match="Cancelled"):
        fit.local_background(original,old,new,check=cancel)
    assert calls==[1]


def test_source_underlighting_is_transferred_without_copying_face_texture():
    h,w=240,180
    source=np.full((5,h,w,3),.25,np.float32)
    donor=np.full_like(source,.5)
    faces=np.tile([40,40,80,120],(5,1)).astype(np.float32)
    source[:,40:90,40:120]=.12
    source[:,130:160,40:120]=.4
    old=np.ones((5,h,w),np.float32)
    relit,gains=fit.scene_relight(source,donor,faces,old,old)
    assert gains.shape==(5,3,3)
    assert relit[2,145,80,0]>relit[2,70,80,0]*2
    np.testing.assert_allclose(relit[0],relit[4])
    assert np.isfinite(relit).all()
