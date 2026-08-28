import os

import numpy as np
import torch
from PIL import Image

import folder_paths


class FastMaskEditor:
    """Image input node: opens the FastMask editor on the painted image and
    outputs the resulting mask (full resolution, even though painting happens
    on a fast preview-resolution surface in the browser)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask_path": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {},
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "load_mask"
    CATEGORY = "mask"
    DESCRIPTION = (
        "Open the FastMask editor (button on the node or right-click menu) "
        "to paint a mask. Output MASK: 1.0 = masked area."
    )

    def load_mask(self, image, mask_path=""):
        b, h, w, _ = image.shape
        mask = None
        if mask_path:
            path = folder_paths.get_annotated_filepath(mask_path)
            if os.path.isfile(path):
                img = Image.open(path).convert("RGBA")
                if img.size != (w, h):
                    img = img.resize((w, h), Image.BILINEAR)
                m = np.asarray(img)[:, :, 3].astype(np.float32) / 255.0
                mask = torch.from_numpy(m)
            else:
                print(f"[FastMask] mask file not found: {path}")
        if mask is None:
            # No mask painted yet -> empty mask (nothing masked).
            mask = torch.zeros((h, w), dtype=torch.float32)
        if b > 1:
            mask = mask.unsqueeze(0).expand(b, h, w).contiguous()
        else:
            mask = mask.unsqueeze(0)
        return (mask,)

    @classmethod
    def IS_CHANGED(cls, image, mask_path="", **kwargs):
        if mask_path:
            path = folder_paths.get_annotated_filepath(mask_path)
            if os.path.isfile(path):
                return os.path.getmtime(path)
        return float("NaN")


NODE_CLASS_MAPPINGS = {
    "FastMaskEditor": FastMaskEditor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FastMaskEditor": "FastMask Editor",
}
