import type { PromptRequest } from '../../core/types.js'
export function buildJxaManagementScript(req: PromptRequest): string {
  return `ObjC.import('Cocoa');
ObjC.import('stdlib');
var alert = $.NSAlert.alloc.init;
alert.messageText = ${JSON.stringify(req.title)};
alert.informativeText = ${JSON.stringify('Phrase: ' + req.phrase)};
['Refresh','Previous','Next','Lock','Unlock','Revoke selected','Close'].forEach(function(t){ alert.addButtonWithTitle(t); });
var view = $.NSView.alloc.initWithFrame($.NSMakeRect(0,0,640,420));
var scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0,50,640,370));
scroll.hasVerticalScroller = true;
var text = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0,0,620,370));
text.editable = false;
text.string = ${JSON.stringify(req.lines.join('\n'))};
scroll.documentView = text;
view.addSubview(scroll);
var domains = ${JSON.stringify(req.domains ?? [])};
var select = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(0,5,640,32),false);
domains.forEach(function(d){ select.addItemWithTitle(d); });
view.addSubview(select);
alert.accessoryView = view;
var response = Number(alert.runModal) - 1000;
var actions = ['refresh','previous','next','lock','unlock','revoke','close'];
var result = {action: actions[response] || 'close'};
if (result.action === 'revoke') {
  var index = Number(select.indexOfSelectedItem);
  if (index < 0 || index >= domains.length) result.action = 'refresh';
  else result.domain = domains[index];
}
$.NSFileHandle.fileHandleWithStandardOutput.writeData(
 $.NSString.alloc.initWithString(JSON.stringify(result)).dataUsingEncoding($.NSUTF8StringEncoding));
$.exit(0);
`
}
