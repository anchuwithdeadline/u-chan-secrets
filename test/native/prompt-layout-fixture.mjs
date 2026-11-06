// Renders fake dialog data only. Does not launch the protected SYSTEM entry point or read vault state.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROMPT_HELPER_CSHARP } from '../../dist/platform/windows/assets/prompt-src.js'
import { compileCsharp } from '../../dist/platform/windows/assets/compiler.js'
const exec=promisify(execFile)
if(process.platform!=='win32')throw new Error('Windows fixture required')
const directory=await mkdtemp(join(tmpdir(),'u-chan-prompt-layout-'))
const fixture=String.raw`
public static class PromptLayoutFixture
{
    public static void Main() { }
    public static void Render(string output, string scenario, string helper)
    {
        System.Windows.Forms.Application.EnableVisualStyles();
        System.Windows.Forms.Application.SetCompatibleTextRenderingDefault(false);
        string phrase = scenario == "long" ? new string('W', 160) : "sample-verification-phrase";
        var lines = new System.Collections.Generic.List<string>();
        if (scenario == "long")
            for (int i = 0; i < 20; i++) lines.Add("Review action " + i + ": https://example.com/a-long-path-for-visible-context");
        else lines.Add("Unlock the vault");
        using (var timer = new System.Windows.Forms.Timer())
        {
            System.Exception failure = null;
            int ticks = 0;
            timer.Interval = 100;
            timer.Tick += delegate {
                if (System.Windows.Forms.Application.OpenForms.Count == 0 || ++ticks < 3) return;
                timer.Stop();
                var form = System.Windows.Forms.Application.OpenForms[0];
                try {
                    if (scenario == "scaled") { form.Scale(new System.Drawing.SizeF(1.5f, 1.5f)); form.PerformLayout(); }
                    using (var preview = new System.Drawing.Bitmap(form.Width, form.Height)) {
                        form.DrawToBitmap(preview, new System.Drawing.Rectangle(0, 0, form.Width, form.Height));
                        preview.Save(output, System.Drawing.Imaging.ImageFormat.Png);
                    }
                    Check(form);
                    var input = FindPassword(form);
                    if (input == null || !input.UseSystemPasswordChar || input.MaxLength != 512) throw new System.Exception("Password masking changed");
                    if (!input.Focused) throw new System.Exception("Password field did not receive focus");
                    var submit = (System.Windows.Forms.Button)form.AcceptButton;
                    if (submit.Enabled) throw new System.Exception("Empty password accepted");
                    input.Text = "fixture-only";
                    if (!submit.Enabled) throw new System.Exception("Submit did not enable");
                    input.Clear();
                } catch (System.Exception error) { failure = error; }
                finally { form.CancelButton.PerformClick(); }
            };
            timer.Start();
            var type = System.Reflection.Assembly.LoadFrom(helper).GetType("UChan.Platform.Windows.Assets.PromptHelper");
            var method = type.GetMethod("RunPasswordDialog", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            int result = (int)method.Invoke(null, new object[] { "U-Chan Secrets - fixture", phrase, lines });
            if (failure != null) throw failure;
            if (result != 1) throw new System.Exception("Cancel result changed");
        }
    }
    private static System.Windows.Forms.TextBox FindPassword(System.Windows.Forms.Control control)
    {
        foreach (System.Windows.Forms.Control child in control.Controls) {
            var text = child as System.Windows.Forms.TextBox;
            if (text != null && text.UseSystemPasswordChar) return text;
            var nested = FindPassword(child); if (nested != null) return nested;
        }
        return null;
    }
    private static void Check(System.Windows.Forms.Control control)
    {
        foreach (System.Windows.Forms.Control child in control.Controls) {
            if (child.Right > control.ClientSize.Width + 1 || child.Bottom > control.ClientSize.Height + 1 || child.Left < 0 || child.Top < 0)
                throw new System.Exception("Control clipped: " + child.GetType().Name + " " + child.Bounds.ToString() + " parent=" + control.ClientSize.ToString());
            var label = child as System.Windows.Forms.Label;
            if (label != null && label.AutoSize && label.GetPreferredSize(new System.Drawing.Size(label.Width, 0)).Height > label.Height + 2)
                throw new System.Exception("Label clipped: " + label.Text);
            Check(child);
        }
    }
}
`
const executable=join(directory,'prompt-fixture.exe')
await compileCsharp(PROMPT_HELPER_CSHARP,executable,{outputType:'WindowsApplication',referencedAssemblies:['System.Windows.Forms.dll','System.Drawing.dll']})
const renderer=join(directory,'render-fixture.exe')
await compileCsharp(fixture,renderer,{outputType:'WindowsApplication',referencedAssemblies:['System.Windows.Forms.dll','System.Drawing.dll']})
for(const scenario of ['unlock','long','scaled']){
  const image=join(directory,scenario+'.png'),script=join(directory,scenario+'.ps1')
  const quote=value=>"'"+value.replaceAll("'","''")+"'"
  await writeFile(script,`$ErrorActionPreference = 'Stop'\n[Reflection.Assembly]::LoadFrom(${quote(renderer)}) | Out-Null\n[PromptLayoutFixture]::Render(${quote(image)},${quote(scenario)},${quote(executable)})\n`)
  await exec('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:15000,maxBuffer:16384})
}
console.log(JSON.stringify({directory,scenarios:['unlock','long','scaled'],scope:'native WinForms layout, fake input, cancellation; excludes protected desktop/SYSTEM verification'}))
