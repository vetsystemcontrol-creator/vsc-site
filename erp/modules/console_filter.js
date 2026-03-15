
(function(){
const warn = console.warn;
console.warn = function(...args){
 const txt = args.join(" ");
 if(txt.includes("[VSC_LICENSE]") || txt.includes("[VSC_AUTH]")){
   return;
 }
 warn.apply(console,args);
};
})();
