import type { PromptRequest } from '../../core/types.js'

export function buildJxaPromptScript(req: PromptRequest): string {
  const phraseBanner = `Anti-phishing phrase: "${req.phrase}"\nVerify this phrase matches your U-Chan setup!`
  const details = req.lines.length > 0 ? `\n\n${req.lines.join('\n')}` : ''
  const informativeText = `${phraseBanner}${details}`

  return `ObjC.import('Cocoa');
ObjC.import('stdlib');
ObjC.import('Carbon');
ObjC.bindFunction('EnableSecureEventInput', ['int', []]);
ObjC.bindFunction('DisableSecureEventInput', ['int', []]);

var alert = $.NSAlert.alloc.init;
alert.messageText = ${JSON.stringify(req.title)};
alert.informativeText = ${JSON.stringify(informativeText)};
alert.addButtonWithTitle('OK');
alert.addButtonWithTitle('Cancel');

var input = $.NSSecureTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 320, 24));
alert.accessoryView = input;
alert.window.initialFirstResponder = input;

if ($.EnableSecureEventInput() !== 0) $.exit(1);
var response;
try {
  response = alert.runModal;
} finally {
  $.DisableSecureEventInput();
}
if (response === $.NSAlertFirstButtonReturn) {
  var pass = input.stringValue.js;
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $.NSString.alloc.initWithString((pass || '') + '\\n').dataUsingEncoding($.NSUTF8StringEncoding)
  );
  $.exit(0);
} else {
  $.exit(1);
}
`
}
