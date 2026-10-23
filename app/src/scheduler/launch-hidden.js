var args = WScript.Arguments;
if (args.length < 2) WScript.Quit(2);

var parts = [];
for (var i = 0; i < args.length; i++) parts.push('"' + args(i) + '"');

var shell = new ActiveXObject('WScript.Shell');
WScript.Quit(shell.Run(parts.join(' '), 0, true));
