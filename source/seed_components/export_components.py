# SPDX-License-Identifier: GPL-3.0-only
# Changed 2026-11-05: standalone corresponding-source export recipe.
# Reuses Seed-VC pinned at 51383efd921027683c89e5348211d93ff12ac2a8.
# No warranty. Redistribution/modification under GPLv3; see GPL-3.0.txt.
# Only generic pretrained checkpoint tensors and synthetic inputs are used.
import os
os.environ.update(CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', OMP_NUM_THREADS='2')
import argparse, hashlib, sys, socket, types
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import torch
import yaml
import onnx
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE/'upstream_seed'))
def no_network(*args,**kwargs):raise RuntimeError('This export recipe uses local files only.')
socket.socket.connect=no_network
socket.create_connection=no_network
def ns(value):return SimpleNamespace(**{k:ns(v) for k,v in value.items()}) if isinstance(value,dict) else value
def remove_metadata(message):
    for field,value in list(message.ListFields()):
        if field.name in ('doc_string','metadata_props'):message.ClearField(field.name)
        elif field.type==field.TYPE_MESSAGE:
            for item in (value if field.is_repeated else [value]):remove_metadata(item)
def lazy_regulator():
    path=HERE/'upstream_seed/modules/length_regulator.py'
    text=path.read_text(encoding='utf-8')
    eager='from dac.nn.quantize import VectorQuantize\n'
    branch='            if vector_quantize:\n'
    assert text.count(eager)==1 and text.count(branch)==1
    text=text.replace(eager,'').replace(branch,branch+'                from dac.nn.quantize import VectorQuantize\n')
    module=types.ModuleType('modules.length_regulator');module.__file__=str(path);module.__package__='modules'
    sys.modules[module.__name__]=module;exec(compile(text,str(path),'exec'),module.__dict__)
    return module.InterpolateRegulator

class FixedWindow(torch.nn.Module):

    def __init__(self, original):
        super().__init__()
        self.original = original
        self.register_buffer('lengths', torch.tensor([67], dtype=torch.int64))

    def forward(self, features):
        return self.original(features, ylens=self.lengths, n_quantizers=3, f0=None)[0]

class Guided(torch.nn.Module):

    def __init__(self, supplied):
        super().__init__()
        self.estimator = supplied
        self.register_buffer('lengths', torch.tensor([83], dtype=torch.long))

    def forward(self, x, prompt, style, condition, t):
        x = torch.cat([torch.zeros_like(x[:, :, :16]), x[:, :, 16:]], dim=2)
        prompt_x = torch.cat([prompt, torch.zeros_like(x[:, :, 16:])], dim=2)
        velocity = self.estimator(torch.cat([x, x], dim=0), torch.cat([prompt_x, torch.zeros_like(prompt_x)], dim=0), self.lengths, torch.cat([t, t], dim=0), torch.cat([style, torch.zeros_like(style)], dim=0), torch.cat([condition, torch.zeros_like(condition)], dim=0))
        conditional, unconditional = velocity.chunk(2, dim=0)
        return 1.5 * conditional - 0.5 * unconditional

def export_lr(checkpoint,out):
    constructor=lazy_regulator()
    model=constructor(channels=384,sampling_ratios=[1,1,1,1],is_discrete=False,in_channels=1024,vector_quantize=False,codebook_size=1024,n_codebooks=2,quantizer_dropout=0.,f0_condition=False,n_f0_bins=512).eval()
    state={k.removeprefix('module.'):v for k,v in checkpoint['net']['length_regulator'].items()}
    model.load_state_dict(state,strict=True)
    wrapper=FixedWindow(model).eval()
    return wrapper,(torch.randn(1,38,1024),),['features'],['condition'],'lr.onnx'
def export_dit(checkpoint,out):
    from modules.flow_matching import CFM
    config=yaml.safe_load((HERE/'config.yml').read_text(encoding='utf-8'))
    model=CFM(ns(config['model_params'])).eval().requires_grad_(False)
    state={k.removeprefix('module.'):v for k,v in checkpoint['net']['cfm'].items()}
    expected=model.state_dict()
    for key in ['estimator.input_pos','estimator.t_embedder.freqs']:
        assert key not in dict(model.named_parameters())
        before=state.get(key)
        if before is None or before.shape!=expected[key].shape:
            if key.endswith('input_pos') and before is not None:
                assert torch.equal(before,torch.arange(before.numel(),dtype=before.dtype))
            state[key]=expected[key]
    model.load_state_dict(state,strict=True)
    estimator=model.estimator;estimator.setup_caches(max_batch_size=2,max_seq_length=88)
    estimator.style_as_token=int(estimator.style_as_token);estimator.time_as_token=int(estimator.time_as_token)
    rng=np.random.default_rng(1203)
    inputs=[torch.from_numpy(rng.normal(0,scale,shape).astype(np.float32)) for shape,scale in [((1,80,83),1.),((1,80,16),.3),((1,192),.1),((1,83,384),.2)]]
    inputs.append(torch.tensor([.4],dtype=torch.float32))
    return Guided(estimator).eval(),tuple(inputs),['state','reference_mel','style','condition','time'],['guided_velocity'],'dit.onnx'
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--checkpoint',type=Path,required=True);parser.add_argument('--component',choices=['lr','dit'],required=True);parser.add_argument('--output-dir',type=Path,default=Path('exported'))
    args=parser.parse_args()
    assert hashlib.sha256(args.checkpoint.read_bytes()).hexdigest()=='c853ea578b409f625f961bcb15d5cff1f8ef9a75f3209ec21d9b7c73ab422e88'
    torch.set_num_threads(2);torch.set_num_interop_threads(1);torch.manual_seed(2025)
    checkpoint=torch.load(args.checkpoint,map_location='cpu',weights_only=True)
    model,inputs,names,outputs,name=(export_lr if args.component=='lr' else export_dit)(checkpoint,args.output_dir)
    args.output_dir.mkdir(parents=True,exist_ok=True);path=args.output_dir/name
    with torch.inference_mode():torch.onnx.export(model,inputs,str(path),opset_version=17,dynamo=False,input_names=names,output_names=outputs)
    graph=onnx.load(str(path));remove_metadata(graph);onnx.checker.check_model(graph);onnx.save(graph,str(path))
if __name__=='__main__':main()
