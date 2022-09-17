
class MenuControl {
  onAdd(map){
    this.map = map;
    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
	this.container.innerHTML =
      '<div class="tools-box">' +
      '<button>' +
      '<span class="maplibregl-ctrl-icon map-menu-button" aria-hidden="true" title="Show menu"></span>' +
      '</button>' +
      '</div>';
	this.container.children[0].onclick = (e)=>(console.log('menu button clicked', this, e));
    return this.container;
  }
  onRemove(){
    this.container.parentNode.removeChild(this.container);
    this.map = undefined;
  }
}