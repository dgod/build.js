var fs=require('fs');
var util=require('util');
var child_process=require('child_process');

var _env={};
var _recursive={};
var _sandbox=[];

function _push(){
	var it={};
	it.env=JSON.stringify(_env);
	it.cwd=process.cwd();
	_sandbox.push(it);
}

function _pop(){
	if(_sandbox.length==0)
		return;
	var it=_sandbox.pop();
	_env=JSON.parse(it.env);
	process.chdir(it.cwd);
}

function _extract(s){
	var begin=-1,end=-1;
	var rec=0;
	for(var i=0;i<s.length;i++){
		if(s[i]=='$' && s[i+1]=='('){
			begin=i;
			rec++;
		} else if(s[i]==')'){
			end=i+1;
			rec--;
			if(rec==0){
				var res={begin:begin,end:end};
				res.name=s.substring(begin+2,end-1);
				return res;
			}
		}
	}
	return null;
}

function _resolv(s){
	if(!s)
		return '';
	do{
		var n=_extract(s);
		if(!n) break;
		s=s.substring(0,n.begin)+$(_resolv(n.name))+s.substring(n.end);
	}while(true);
	return s;
}

function _mtime(file){
	try{
		var stats=fs.statSync(file);
	}catch(e){
		return 0;
	}
	return stats.mtime.getTime();
}

function _get_includes(cflags){
	var res=[];
	if(!cflags)
		return res;
	var list=cflags.split(' ');
	for(var i=0;i<list.length;i++){
		var s=list[i];
		if(s[0]=='-' && s[1]=='I')
			res.push(s.substring(2));
	}
	return res;
}

function _deps_get(file,vpath,includes,deps,check){
	if(check[file])
		return;
	check[file]=true;
	var text=fs.readFileSync(file,{"encoding":"utf-8"});
	var list=text.split('\n');
	for(var i=0;i<list.length;i++){
		var s=list[i];
		var res=s.match(/^\s*#include\s*"([^"]*)/);
		if(res){
			var from=0;
		} else {
			res=s.match(/^\s*#include\s*<([^>]*)/);
			if(res){
				var from=1;
			}
		}
		if(!res || res.length!=2)
			continue;
		s=res[1];
		var real;
		if(from==0){
			if(fs.existsSync(s)){
				real=s;
			} else {
				for(var j=0;j<vpath.length;j++){
					var path=vpath[j]+'/'+s;
					if(fs.existsSync(path)){
						real=path;
						break;
					}
				}
			}
		}
		if(!real){
			for(var j=0;j<includes.length;j++){
				var path=includes[j]+'/'+s;
				if(fs.existsSync(path)){
					real=path;
					break;
				}
			}
		}
		if(real){
			for(var j=0;j<deps.length;j++){
				if(deps[j]==real) break;
			}
			if(j==deps.length) {
				deps.push(real);
				_deps_get(real,vpath,includes,deps,check);
			}
		}
	}
}
function _cfile(file){
	return file.match(/\x2E[ch]$/);
}

function _deps_changed(input,output){
	if(typeof(output)=="number")
		var output_mtime=output;
	else
		var output_mtime=_mtime(output);
	if(output_mtime<=0)
		return true;
	if(util.isArray(input)){
		for(var i=0;i<input.length;i++){
			if(input[i]=="") continue;
			var changed=_deps_changed(input[i],output_mtime);
			if(changed)
				return true;
		}
		return false;
	}
	if(_mtime(input)>=output_mtime)
		return true;
	if(!_cfile(input))
		return false;
	var vpath=$('VPATH').split(' ');
	var includes=_get_includes($('CFLAGS'));
	var deps=[];
	var check={};
	_deps_get(input,vpath,includes,deps,check);
	for(var i=0;i<deps.length;i++){
		if(_mtime(deps[i])>=output_mtime)
			return true;
	}
	return false;
}

function env(name,op,val){
	if(util.isArray(val))
		val=val.join(' ');
	if(op=='='){
		_env[name]=val;
	} else if(op=='?='){
		if(_env[name])
			return;
		_env[name]=_resolv(val);
	} else if(op==':='){
		_env[name]=_resolv(val);
	} else if(op=='+='){
		if(!_env[name])
			_env[name]=val;
		else
			_env[name]+=' '+val;
	} else if(!op){
		var i=name.indexOf('=');
		if(i<=0)
			return;
		val=name.substring(i+1);
		i--;
		if(name[i]=='?' || name[i]==':' || name[i]=='+')
			op=name.substr(i,2);
		else{
			op='=';
			i++;
		}
		name=name.substr(0,i);
		env(name,op,val);
	}
}

function $(name){
	if(_recursive[name])
		return '';
	_recursive[name]=true;
	var res=_resolv(_env[name]);
	_recursive[name]=false;
	return res;
}

function cc(input,output){
	if(util.isArray(input) && !output){
		for(var i=0;i<input.length;i++){
			cc(input[i]);
		}
		return;
	}
	if(util.isArray(input) && util.isArray(output) && input.length==output.length){
		for(var i=0;i<input.length;i++){
			cc(input[i],output[i]);
		}
		return;
	}
	var _cc=$('CC');
	if(_cc.length==0) _cc='gcc';
	if(!output)
		output=input.replace('.c','.o');
	if(!_deps_changed(input,output))
		return;
	var cmd=_cc+' '+$('CFLAGS')+' -c '+input+' -o '+output;
	exec(cmd);
}

function ld(input,output){
	output=_resolv(output);
	if(util.isArray(input)){
		if(!_deps_changed(input,output))
			return;
		input=input.join(' ');
	} else {
		var temp=input.split(' ');
		if(!_deps_changed(temp,output))
			return;
	}
	var cc=$('CC');
	if(cc.length==0) cc='gcc';
	var cmd=cc+' '+$('CFLAGS')+' '+$('LDFLAGS')+' '+input+' '+' -o '+output+' '+$('LIBS');
	exec(cmd);
}

function include(_file){
	var _code=fs.readFileSync(_file,{"encoding":"utf-8"});
	eval(_code);
}

function make(_path,_file,target){
	_push();
	if(_path)
		process.chdir(_path);
	if(!_file)
		_file="build.txt";
	var _code=fs.readFileSync(_file,{"encoding":"utf-8"});
	eval(_code);
	_pop();
}

function shell(command){
	return child_process.execSync(_resolv(command),{"encoding":"utf-8"});
}

function exec(command){
	command=_resolv(command);
	console.log(command);
	try{
		var text=child_process.execSync(command,{"encoding":"utf-8"});
		if(text && text.length>0)
			console.log(text);
	}catch(e){
		process.exit(1);
	}
}

function pkgconfig(args){
	return shell("pkg-config "+args);
}

function rm(file){
	if(util.isArray(file)){
		for(var i=0;i<file.length;i++){
			rm(file[i]);
		}
	} else {
		file=_resolv(file);
		try{
			fs.unlinkSync(file);
			console.log("rm "+file);
		}catch(e){
		}
	}
}

function rmdir(path){
	if(util.isArray(path)){
		for(var i=0;i<path.length;i++){
			rmdir(path[i]);
		}
	} else {
		path=_resolv(path);
		try{
			fs.rmdirSync(path);
			console.log("rmdir "+path);
		} catch(e){
		}
	}
}

function dir(path,filter){
	var temp=fs.readdirSync(path);
	if(!filter)
		return temp;
	var res=[];
	for(var i=0;i<temp.length;i++){
		if(temp[i].match(filter)){
			res.push(temp[i]);
		}
	}
	return res;
}

function wildcard(input,change){
	var output=[];
	if(typeof(change)=="function"){
		for(var i=0;i<input.length;i++){
			output.push(change(input[i]));
		}
	} else {
		for(var i=0;i<input.length;i++){
			output.push(input[i].replace(change[0],change[1]));
		}
	}
	return output;
}

function cd(path){
	process.chdir(path);
}

function _run(){
	var argv=process.argv;
	var i=1;
	if(argv[1].indexOf("build.js")>=0)
		i++;
	var path;
	var file;
	var task=0;
	for(;i<argv.length;i++){
		if(argv[i]=='-C'){
			path=argv[i+1];
			i++;
			continue;
		} else if(argv[i]=='-f'){
			file=argv[i+1];
			i++;
			continue;
		} else if(argv[i].indexOf('=')>0) {
			var t=argv[i].split('=',2);
			env(t[0],'=',t[1]);
		}
		make(path,file,argv[i]);
		file=undefined;
		task++;
	}
	if(task==0)
		make(path,file);
}

_run();
